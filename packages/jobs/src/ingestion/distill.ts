import {
  countPopulatedFields,
  distillProduct,
  rollUpRichness,
  type DistillPrompt,
  type StoreRichness,
} from '@sortiva/core'
import {
  accountScope,
  productFactsForAccount,
  productsForDistillation,
  storedProductStates,
  upsertProductFacts,
  type DistillableProductRecord,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import { RetryableFailure, TerminalFailure } from '../runtime/errors'
import { deriveIdempotencyKey, inputVersion } from '../runtime/idempotency'
import { lookupCompletedWork, recordCompletedWork } from '../runtime/ledger'
import type { StepContext } from '../runtime/runStep'
import type { IngestionDeps } from './deps'
import type { StepDefinition } from './steps'

/**
 * Step four: reading what the merchant wrote about each product, once, and
 * keeping only the facts.
 *
 * This is the first step that spends real money — one model call per product,
 * across a whole catalogue — so almost everything here is about not spending it
 * twice. Three separate mechanisms have to agree before a call is made:
 *
 *  1. **The per-product ledger key**, derived from the product's own
 *     `updated_at` and the checksum of its words. A product nobody edited
 *     produces the same key as last night, the ledger already holds it, and the
 *     product is skipped without a call, a read of its description, or a write.
 *  2. **The request cache inside the model wrapper**, keyed on the rendered
 *     prompt and written *before* the answer is processed — so a crash between
 *     the model answering and us storing the sheet replays the stored
 *     completion rather than paying again.
 *  3. **The step's own ledger key**, over the whole catalogue's fingerprints, so
 *     a redelivered dispatch of finished work returns the stored answer.
 *
 * A product with no usable description costs nothing at all: it gets an empty
 * fact sheet, which is a true statement about that product and is precisely
 * what the store's richness score is built to notice.
 */

/**
 * Products per database round trip. Each row carries a description, so this is
 * also how much text is in memory at once — deliberately small.
 */
const BATCH_SIZE = 25

/**
 * How many products one run of the step distils before handing the rest back.
 *
 * A step that ran an unbounded catalogue would hold the account's lock past its
 * lease and be reclaimed mid-flight. Whatever is left resumes on the next
 * attempt and costs nothing to re-reach, because everything already done is in
 * the ledger.
 */
const PRODUCTS_PER_RUN = 400

/** Where a run of the step got to. Committed after every batch. */
export interface DistillCheckpoint {
  /** The last product id written. The walk continues after it, in id order. */
  readonly afterProductId?: string
  readonly distilled: number
  /** Products whose work was already in the ledger — no call, no cost. */
  readonly replayed: number
  readonly modelCalls: number
}

export interface DistillOutput {
  readonly productsDistilled: number
  readonly productsReplayed: number
  /** How many products actually reached the model. Less than the count above by every product with nothing to say. */
  readonly modelCalls: number
  readonly richness: StoreRichness
}

export const distillStep: StepDefinition = {
  /**
   * The whole catalogue's fingerprints, as the sync left them.
   *
   * A key over the account alone would make every night after the first a
   * no-op and the fact sheets would never move again; a key over the day would
   * re-walk an unchanged catalogue every night. Over the fingerprints, a run
   * that changes nothing *is* the same work, and is recognised as such.
   */
  async inputVersion(deps, accountId) {
    const states = await storedProductStates(deps.db, accountScope(accountId))
    const catalogue = [...states.entries()]
      .map(([shopifyId, state]) => `${shopifyId}|${state.updatedAt?.toISOString() ?? ''}|${state.checksum ?? ''}`)
      .sort()
    return inputVersion({ catalogue })
  },

  async execute(deps, rawCtx): Promise<DistillOutput> {
    const ctx = rawCtx as StepContext<DistillCheckpoint>
    const llm = requireLlm(deps)
    const prompt = requirePrompt(deps)
    const scope = accountScope(ctx.accountId)
    const domain = await deps.domains.readNormalized(ctx.accountId)

    let state: DistillCheckpoint = ctx.checkpoint ?? { distilled: 0, replayed: 0, modelCalls: 0 }
    let seenThisRun = 0

    for (;;) {
      stopIfShuttingDown(ctx)

      const batch = await productsForDistillation(deps.db, scope, {
        ...(state.afterProductId ? { after: state.afterProductId } : {}),
        limit: BATCH_SIZE,
      })
      if (batch.length === 0) break

      for (const product of batch) {
        const key = productKey(ctx.accountId, product)

        // "Have I already distilled exactly this product's words?" — the
        // question and the answer are one lookup, and a hit is the whole
        // saving: no description read, no model call, no write.
        if (await lookupCompletedWork(deps.db, key)) {
          state = { ...state, afterProductId: product.id, replayed: state.replayed + 1 }
          continue
        }

        const result = await distillProduct(
          { llm, prompt },
          {
            accountId: ctx.accountId,
            ...(domain === undefined ? {} : { domain }),
            product: {
              productId: product.id,
              title: product.title,
              descriptionText: product.descriptionText,
              priceRange: product.priceRange,
              options: product.options,
            },
          },
        )

        await upsertProductFacts(deps.db, scope, {
          productId: product.id,
          factSheet: result.factSheet,
          fluffDiscarded: result.factSheet.fluff_discarded,
          promptVersion: result.promptVersion,
          modelId: result.modelId,
        })

        // The sheet is written first and the ledger second, so a crash between
        // them re-distils one product rather than losing its sheet. That
        // re-distillation is free: the wrapper replays the stored completion.
        await recordCompletedWork(deps.db, key, {
          productId: product.id,
          factCount: result.factSheet.fact_count,
          promptVersion: result.promptVersion,
          modelId: result.modelId,
        })

        state = {
          ...state,
          afterProductId: product.id,
          distilled: state.distilled + 1,
          modelCalls: state.modelCalls + (result.modelCalled ? 1 : 0),
        }
      }

      // Committed once per batch. Within a batch the ledger is the finer
      // record — a crash mid-batch resumes at the first product whose key is
      // not yet there — so a write per product would buy nothing.
      await ctx.save(state)

      seenThisRun += batch.length
      if (batch.length < BATCH_SIZE) break
      if (seenThisRun >= PRODUCTS_PER_RUN) {
        throw new RetryableFailure(
          'distill_budget',
          `Distilled ${seenThisRun} products this run and the catalogue has more; continuing on the next attempt.`,
        )
      }
    }

    const richness = await storeRichness(deps, scope)

    ctx.log.info('distill.completed', {
      products_distilled: state.distilled,
      products_replayed: state.replayed,
      model_calls: state.modelCalls,
      richness_band: richness.band,
      richness_score: richness.score,
      products_missing_details: richness.productsMissingDetails,
    })

    return {
      productsDistilled: state.distilled,
      productsReplayed: state.replayed,
      modelCalls: state.modelCalls,
      richness,
    }
  },
}

/**
 * One product's key: the product, its last edit, and the checksum of its words.
 *
 * The checksum deliberately covers the product's *words and attributes* and not
 * its price or its stock, so a weekend sale across a whole shop does not buy a
 * fresh distillation of every product in it.
 */
export function productKey(accountId: string, product: DistillableProductRecord): string {
  return deriveIdempotencyKey(
    accountId,
    'distill',
    inputVersion({
      product: product.shopifyProductId,
      updatedAt: product.updatedAt?.toISOString() ?? null,
      checksum: product.checksum,
    }),
  )
}

/**
 * The store's richness, recomputed from every sheet we hold rather than
 * accumulated as the walk goes: a run that only distilled the twelve products
 * that changed must still describe the whole catalogue.
 *
 * The two numbers it is judged against are the substance floor in
 * `packages/rules` — the same floor the Opportunity Engine later applies when
 * deciding whether there is enough to write about. One judgement, one pair of
 * numbers.
 *
 * Exported because the persona step stamps this number on the stored profile,
 * where the confirmation screen reads it. Recomputing it there from the same
 * sheets is the only way the two can never disagree.
 */
export async function storeRichness(
  deps: IngestionDeps,
  scope: ReturnType<typeof accountScope>,
): Promise<StoreRichness> {
  const sheets = await productFactsForAccount(deps.db, scope)
  const floor = rules().defaults.gates.substance_floor
  return rollUpRichness(
    sheets.map((sheet) => ({
      // Recomputed from the stored sheet rather than stored beside it: there
      // is no column for it, and adding one is a schema wave's decision rather
      // than a feature card's. The sheet is in the same row anyway.
      populatedFields: countPopulatedFields(sheet.factSheet),
      factCount: sheet.factCount,
    })),
    {
      populatedFieldsPerProductMin: floor.populated_fields_per_product_min,
      marginMultiple: floor.margin_multiple,
    },
  )
}

function requireLlm(deps: IngestionDeps) {
  if (!deps.llm) {
    throw new TerminalFailure(
      'no_llm_client',
      'Distillation needs the instrumented model client; the process did not supply one.',
    )
  }
  return deps.llm
}

function requirePrompt(deps: IngestionDeps): DistillPrompt {
  if (!deps.distillPrompt) {
    throw new TerminalFailure(
      'no_distill_prompt',
      'Distillation needs its versioned prompt; the process did not supply one.',
    )
  }
  return deps.distillPrompt
}

/**
 * A deploy is not a crash, but it ends the process just as firmly. Stopping on
 * the signal means the batch committed a moment ago is where the next worker
 * starts, rather than a model call being killed after we have paid for it.
 */
function stopIfShuttingDown(ctx: StepContext<DistillCheckpoint>): void {
  if (ctx.signal.aborted) {
    throw new RetryableFailure(
      'shutting_down',
      'The process is shutting down; distillation resumes from its saved position.',
    )
  }
}
