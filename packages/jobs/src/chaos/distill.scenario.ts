import { drizzle } from 'drizzle-orm/node-postgres'
import {
  staticShopifyAuth,
  type LlmClient,
  type LlmRequest,
  type LlmResult,
  type ShopifyAccessGrant,
  type ShopifyAuth,
  type StoreConnection,
} from '@sortiva/core'
import { accountScope, productFactsForAccount, schema, upsertProducts } from '@sortiva/db'
import { MockLlmClient } from '@sortiva/llm'
import { distillStep } from '../ingestion/distill'
import type { ConnectionStore, IngestionDeps } from '../ingestion/deps'
import { deriveIdempotencyKey } from '../runtime/idempotency'
import { runStep } from '../runtime/runStep'
import { createRun, findStep, getStep } from '../runtime/steps'
import { WorkerKilled, type ChaosContext, type ChaosScenario } from './harness'

/**
 * Killing distillation between two products' model calls.
 *
 * Distillation is the first step that spends money per item rather than once,
 * so the failure this scenario exists to catch is different from the
 * catalogue sync's: not "did we re-read a page" but "did we re-pay for a
 * product whose sheet we already wrote". The per-product ledger key
 * (`productKey` in `../ingestion/distill.ts`) is what is meant to answer that
 * — this proves it does, across a kill that lands mid-batch, before the
 * step's own checkpoint would have been committed at all.
 */

const PROMPT = { version: 'distill.v1', text: 'extract only, never infer' }
const PRODUCT_COUNT = 6

interface State {
  jobId: string
  stepId: string
  key: string
  /** Every product the model was actually asked about, across every attempt. */
  calledFor: string[]
}

const state: State = { jobId: '', stepId: '', key: '', calledFor: [] }

function sheetFor(): string {
  return JSON.stringify({
    material: 'leather',
    dimensions: null,
    weight: null,
    capacity: '20 L',
    compatibility: [],
    use_cases_stated: ['commuting'],
    care: null,
    certifications: [],
    origin: null,
    verifiable_claims: [],
    fluff_discarded: true,
  })
}

/**
 * Wraps the model wrapper's own test double with one kill point per call — the
 * same shape as `catalog-sync.scenario.ts`'s `ChaosShopify`, one layer further
 * in. Every call this wrapper sees is a product distillation still had to pay
 * for; a product already in the ledger never reaches it.
 */
/** The grant nothing in this scenario asks for: it never installs anything. */
const NO_GRANT: ShopifyAccessGrant = {
  accessToken: '',
  grantedScopes: [],
  expiresAt: null,
  refreshToken: null,
  refreshTokenExpiresAt: null,
}

class ChaosLlm implements LlmClient {
  killedAt: string | undefined

  constructor(
    private readonly inner: MockLlmClient,
    private readonly ctx: ChaosContext,
  ) {}

  async complete<T = unknown>(request: LlmRequest): Promise<LlmResult<T>> {
    const label = `product-call-${state.calledFor.length + 1}`
    try {
      this.ctx.checkpoint(label)
    } catch (error) {
      if (error instanceof WorkerKilled) this.killedAt = label
      throw error
    }
    state.calledFor.push(label)
    return this.inner.complete<T>(request)
  }
}

class ChaosConnections implements ConnectionStore {
  constructor(private readonly accountId: string) {}

  async read(): Promise<StoreConnection | undefined> {
    return {
      accountId: this.accountId,
      shopHandle: 'chaos-store',
      grantedScopes: ['read_products'],
      connectedAt: new Date('2026-09-01T09:00:00Z'),
      invalidatedAt: null,
    }
  }

  async authFor(): Promise<ShopifyAuth> {
    return staticShopifyAuth('chaos-store', 'shpat_chaos')
  }

  async markInvalid(_accountId: string, at: Date): Promise<Date> {
    return at
  }
}

/** Everything but the model client — shared between `inputVersion` (needs none of it but `db`) and `execute` (needs all of it). */
function baseDeps(pool: ChaosContext['pool'], accountId: string): Omit<IngestionDeps, 'llm' | 'distillPrompt'> {
  return {
    db: drizzle(pool, { schema }),
    pool,
    fetcher: { async fetch() { throw new Error('distillation makes no page fetches') } },
    shopify: {
      authorizeUrl: () => '',
      verifyCallbackSignature: () => true,
      exchangeCode: async () => NO_GRANT,
      refreshAccess: async () => NO_GRANT,
      revokeAccess: async () => {},
    },
    shop: { async getShop() { throw new Error('not used') } },
    connections: new ChaosConnections(accountId),
    domains: {
      async findAccountByShopHandle() { return accountId },
      async setPlatform() {},
      async transition() { return undefined },
      async read() { return 'ingesting' },
      async readNormalized() { return 'chaos.example' },
    },
  }
}

function chaosDeps(ctx: ChaosContext, llm: ChaosLlm): IngestionDeps {
  return { ...baseDeps(ctx.pool, ctx.accountId), llm, distillPrompt: PROMPT }
}

export const distillKilledMidBatch: ChaosScenario = {
  name: 'distill_killed_mid_batch',
  // A clean pass reaches exactly `PRODUCT_COUNT` checkpoints — telling the
  // harness so up front means its first draw always lands inside that range.
  initialCeiling: PRODUCT_COUNT,

  async setup(pool, accountId) {
    const db = drizzle(pool, { schema })
    // `product_facts` carries no account column of its own — it cascades from
    // `products` — so deleting the products is the whole cleanup.
    await pool.query('DELETE FROM products WHERE account_id = $1', [accountId])

    for (let i = 1; i <= PRODUCT_COUNT; i += 1) {
      await upsertProducts(db, accountScope(accountId), [
        {
          shopifyProductId: String(i),
          title: `Chaos Tote ${i}`,
          rawBodyHtml: `<p>A leather tote, item ${i}, holding 20 L for everyday commuting.</p>`,
          productType: null,
          tags: [],
          variants: [],
          priceRange: { min: 89, max: 129 },
          updatedAt: new Date('2026-06-14T10:00:00Z'),
          checksum: `c${i}`,
        },
      ])
    }

    const { jobId } = await createRun(db, accountId, `chaos-distill-${Date.now()}`, ['distill'])
    const step = await findStep(db, jobId, 'distill')
    state.jobId = jobId
    state.stepId = step!.id
    // `inputVersion` reads only `deps.db` — a full `ChaosLlm` is pointless here.
    state.key = deriveIdempotencyKey(
      accountId,
      'distill',
      await distillStep.inputVersion(baseDeps(pool, accountId) as IngestionDeps, accountId),
    )
    state.calledFor = []
  },

  async drive(ctx) {
    const db = drizzle(ctx.pool, { schema })

    await ctx.pool.query(
      `UPDATE job_steps SET attempts = 0, next_attempt_at = NULL WHERE id = $1`,
      [state.stepId],
    )

    const mock = new MockLlmClient()
    mock.setDefault('distill', () => sheetFor())
    const llm = new ChaosLlm(mock, ctx)

    const outcome = await runStep({
      db,
      pool: ctx.pool,
      accountId: ctx.accountId,
      jobId: state.jobId,
      stepId: state.stepId,
      idempotencyKey: state.key,
      leaseMs: 0,
      handler: (stepCtx) => distillStep.execute(chaosDeps(ctx, llm), stepCtx),
    })

    if (llm.killedAt !== undefined) throw new WorkerKilled(llm.killedAt)

    if (outcome.status !== 'succeeded') {
      throw new Error(`distillation did not converge: ${outcome.status}`)
    }
  },

  async assert(ctx) {
    const db = drizzle(ctx.pool, { schema })

    const step = await getStep(db, state.stepId)
    if (step?.state !== 'succeeded') {
      throw new Error(`the step did not converge: ${step?.state}`)
    }

    const sheets = await productFactsForAccount(db, accountScope(ctx.accountId))
    if (sheets.length !== PRODUCT_COUNT) {
      throw new Error(`expected ${PRODUCT_COUNT} fact sheets after the kills; found ${sheets.length}`)
    }

    // No product was ever asked about twice. Every kill lands before the
    // step's own per-batch checkpoint commits, so this is the ledger's
    // resumability under test, not the checkpoint's.
    if (state.calledFor.length !== PRODUCT_COUNT) {
      throw new Error(
        `expected exactly ${PRODUCT_COUNT} model calls across every attempt; made ${state.calledFor.length} — a kill re-paid for a product already distilled`,
      )
    }

    const ledger = await ctx.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM idempotency_ledger WHERE idempotency_key = $1',
      [state.key],
    )
    if (ledger.rows[0]?.n !== 1) {
      throw new Error(`expected one ledger record for the finished step; found ${ledger.rows[0]?.n}`)
    }
  },
}
