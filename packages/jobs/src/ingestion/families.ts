import {
  accountAttribution,
  countPopulatedFields,
  emptyFactSheet,
  groupProducts,
  type GroupingInput,
} from '@sortiva/core'
import {
  accountScope,
  productsForGrouping,
  reconcileFamilies,
  type GroupableProduct,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import { inputVersion } from '../runtime/idempotency'
import type { IngestionDeps } from './deps'
import type { StepDefinition } from './steps'

/**
 * Step five: deciding what this store actually sells, as a handful of subjects
 * rather than a list of products.
 *
 * A store with forty similar shoes cannot support forty shoe articles, and
 * everything after this point — which topics are worth writing, whether there
 * is enough substance behind one, which products an article may cite — operates
 * on families. So this step is where a catalogue stops being rows and becomes
 * the thing the product reasons about.
 *
 * It spends nothing. No model call, no vendor call, no billable read: every
 * signal it uses is already in our own tables, which is why it can be re-run
 * freely and why it needs no request cache. The one number it borrows from
 * elsewhere is the substance floor — the same bar a product must clear to be
 * written about is the bar it must clear to be grouped by similarity, so the
 * two judgements can never disagree.
 */

export interface FamilyGroupOutput {
  readonly productsGrouped: number
  readonly familiesCreated: number
  readonly familiesUpdated: number
  readonly familiesRemoved: number
  readonly logicalProductsMerged: number
  /** Families with no axes: nothing about their members' facts differs enough to compare. */
  readonly familiesWithoutAxes: number
}

/** The event the activation funnel reads. Ids and counts only — invariant 26. */
export const FAMILY_GROUPING_COMPLETED_EVENT = 'family_grouping_completed'

/**
 * Why there is no checkpoint here, unlike the two steps before it.
 *
 * A checkpoint exists so a killed step resumes rather than restarts, and it is
 * worth having when restarting costs something — eight minutes of paced Shopify
 * reads, or a catalogue's worth of model calls. This step makes no network call
 * and pays nobody: it is two queries and some arithmetic, and re-running it from
 * the start costs milliseconds. A family is also a property of the whole
 * catalogue rather than of a page of it, so a half-finished grouping is not a
 * position to resume from — it is an answer to a different question.
 */
export const familyGroupStep: StepDefinition = {
  /**
   * Every fact sheet, by when it was made, plus the fingerprint of each
   * product's words and attributes.
   *
   * Both halves are load-bearing. The fact sheets are what clustering compares,
   * so a re-distillation is genuinely different work; the product fingerprints
   * cover the tags and the `product_type`, which grouping reads directly and
   * which a merchant can change without touching a description. A key over
   * either alone would let a re-filing of the whole catalogue return yesterday's
   * families.
   */
  async inputVersion(deps, accountId) {
    const catalogue = (await productsForGrouping(deps.db, accountScope(accountId)))
      .map(
        (product) =>
          `${product.shopifyProductId}|${product.checksum ?? ''}|${product.distilledAt?.toISOString() ?? ''}`,
      )
      .sort()
    return inputVersion({ catalogue })
  },

  async execute(deps, ctx): Promise<FamilyGroupOutput> {
    const scope = accountScope(ctx.accountId)
    const floor = rules().defaults.gates.substance_floor
    const options = { populatedFieldsPerProductMin: floor.populated_fields_per_product_min }

    const catalogue = await productsForGrouping(deps.db, scope)
    const plan = groupProducts(catalogue.map(toGroupingInput), options)

    const reconciliation = await reconcileFamilies(
      deps.db,
      scope,
      plan.families.map((family) => ({
        name: family.name,
        memberProductIds: family.memberProductIds,
        differentiationAxes: family.axes,
        mergedFacts: family.mergedFacts,
        groupingSource: family.groupingSource,
        confidence: family.confidence,
      })),
      plan.logicalProducts,
      deps.now?.() ?? new Date(),
    )

    const logicalProductsMerged = countMergedGroups(plan.logicalProducts)
    const familiesWithoutAxes = plan.families.filter((family) => family.axes.length === 0).length

    const output: FamilyGroupOutput = {
      productsGrouped: reconciliation.productsAssigned,
      familiesCreated: reconciliation.created,
      familiesUpdated: reconciliation.updated,
      familiesRemoved: reconciliation.removed,
      logicalProductsMerged,
      familiesWithoutAxes,
    }

    ctx.log.info('family_group.completed', {
      products_grouped: output.productsGrouped,
      families: plan.families.length,
      families_created: output.familiesCreated,
      families_updated: output.familiesUpdated,
      families_removed: output.familiesRemoved,
      logical_products_merged: output.logicalProductsMerged,
      families_without_axes: output.familiesWithoutAxes,
    })

    // Fired after the write rather than before it, so the funnel counts stores
    // whose families actually exist. Carries counts and a store's own id and
    // nothing else: a family name is the merchant's word for their own
    // products, which is store content and may not leave in an event.
    deps.capture?.capture({
      event: FAMILY_GROUPING_COMPLETED_EVENT,
      attribution: accountAttribution(ctx.accountId),
      properties: {
        products_grouped: output.productsGrouped,
        families: plan.families.length,
        families_without_axes: output.familiesWithoutAxes,
        logical_products_merged: output.logicalProductsMerged,
        grouping_sources: countBySource(plan.families),
        low_confidence_families: plan.families.filter((family) => family.confidence === 'low')
          .length,
      },
    })

    return output
  },
}

/**
 * One stored product as grouping reads it.
 *
 * A product distillation has not reached yet gets an empty sheet rather than
 * being skipped. That is the honest reading — we know nothing about it — and it
 * is what puts it below the substance floor, so it stays a family of one
 * instead of being merged into whatever it happens to resemble. A product whose
 * page genuinely said nothing arrives here the same way, which is deliberate:
 * "not distilled" and "nothing to distil" are the same amount of knowledge.
 */
function toGroupingInput(product: GroupableProduct): GroupingInput {
  const factSheet = product.factSheet ?? emptyFactSheet()
  return {
    productId: product.productId,
    title: product.title,
    factSheet,
    populatedFields: countPopulatedFields(factSheet),
    tags: product.tags,
    productType: product.productType,
  }
}

function countMergedGroups(logicalProducts: ReadonlyMap<string, string>): number {
  const sizes = new Map<string, number>()
  for (const groupKey of logicalProducts.values()) {
    sizes.set(groupKey, (sizes.get(groupKey) ?? 0) + 1)
  }
  return [...sizes.values()].filter((size) => size > 1).length
}

function countBySource(
  families: readonly { readonly groupingSource: string }[],
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const family of families) {
    counts[family.groupingSource] = (counts[family.groupingSource] ?? 0) + 1
  }
  return counts
}
