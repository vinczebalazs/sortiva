import { drizzle } from 'drizzle-orm/node-postgres'
import type pg from 'pg'
import {
  staticShopifyAuth,
  type ShopifyAccessGrant,
  type ShopifyAuth,
  type ShopifyOrder,
  type ShopifyProduct,
  type StoreConnection,
} from '@sortiva/core'
import { readCatalogChanges, schema, systemScope } from '@sortiva/db'
import { catalogSyncStep } from '../ingestion/catalog'
import type { ConnectionStore, IngestionDeps, ShopifyListReader } from '../ingestion/deps'
import { deriveIdempotencyKey } from '../runtime/idempotency'
import { runStep } from '../runtime/runStep'
import { createRun, findStep, getStep } from '../runtime/steps'
import { WorkerKilled, type ChaosContext, type ChaosScenario } from './harness'

/**
 * Killing the catalogue sync part-way through reading a merchant's store.
 *
 * This is the scenario the harness was built expecting. The catalogue sync is
 * the longest thing the product does over a network — minutes of paced requests
 * against somebody else's server — so it is the step most likely to be running
 * when a deploy, a crash or a killed container ends the process.
 *
 * What must hold afterwards is not "it finished" but "it finished *once*": every
 * product present exactly once, every change recorded exactly once, and one
 * completion record for the work. A sync that re-read the store from the
 * beginning after every kill would also end up with the right products, and
 * would be wrong — it would spend a merchant's whole request budget again and,
 * for the steps that follow this one, spend real money again.
 */

const TOTAL_PRODUCTS = 12
const PAGE_SIZE = 2

interface State {
  jobId: string
  stepId: string
  key: string
  /** Every product page the store was asked for, across every attempt. */
  requested: string[]
}

const state: State = { jobId: '', stepId: '', key: '', requested: [] }

/** The grant nothing in this scenario asks for: it never installs anything. */
const NO_GRANT: ShopifyAccessGrant = {
  accessToken: '',
  grantedScopes: [],
  expiresAt: null,
  refreshToken: null,
  refreshTokenExpiresAt: null,
}

/** A store that pages, and that lets the harness kill us between pages. */
class ChaosShopify implements ShopifyListReader {
  /**
   * The kill the harness delivered on this pass, if any.
   *
   * The step runner catches every exception a handler throws and turns it into a
   * retry — which is exactly right in production and hides the kill from the
   * harness, which recognises a killed pass by the exception coming back out.
   * So the kill is remembered here and re-thrown by the driver once the runner
   * has finished settling the step.
   */
  killedAt: string | undefined

  constructor(private readonly ctx: ChaosContext) {}

  private killPoint(label: string): void {
    try {
      this.ctx.checkpoint(label)
    } catch (error) {
      if (error instanceof WorkerKilled) this.killedAt = label
      throw error
    }
  }

  async listProducts(
    _auth: ShopifyAuth,
    options: { after?: string } = {},
  ): Promise<{ items: readonly ShopifyProduct[]; next: string | undefined }> {
    const offset = Number(options.after ?? '0')
    state.requested.push(`products:${offset}`)

    // One kill point per page, so the harness can end the process at any point
    // in the walk rather than only at a convenient one.
    this.killPoint(`products-page-${offset}`)

    const items = Array.from({ length: PAGE_SIZE }, (_unused, i) => offset + i + 1)
      .filter((id) => id <= TOTAL_PRODUCTS)
      .map((id) => ({
        id: String(id),
        title: `Product ${id}`,
        body_html: `<p>Words about product ${id}.</p>`,
        handle: `product-${id}`,
        product_type: 'Shoes',
        tags: 'trail',
        status: 'active',
        updated_at: '2026-06-14T10:00:00Z',
        variants: [
          { id: String(id * 10), title: 'One size', sku: `SKU-${id}`, price: '50.00', available: true },
        ],
        images: [],
        metafields: [],
      }))

    const next = offset + PAGE_SIZE < TOTAL_PRODUCTS ? String(offset + PAGE_SIZE) : undefined
    return { items, next }
  }

  async listOrders(
    _auth: ShopifyAuth,
    _options: { createdFrom: Date; after?: string },
  ): Promise<{ items: readonly ShopifyOrder[]; next: string | undefined; timeZone: string | null }> {
    state.requested.push('orders')
    // A kill point right at the phase boundary: the walk has finished and the
    // order read has not started, which is the moment the checkpoint changes
    // shape rather than merely advancing.
    this.killPoint('orders-page')
    return { items: [], next: undefined, timeZone: 'Europe/London' }
  }
}

class ChaosConnections implements ConnectionStore {
  constructor(private readonly accountId: string) {}

  async read(): Promise<StoreConnection | undefined> {
    return {
      accountId: this.accountId,
      shopHandle: 'chaos-store',
      grantedScopes: ['read_products', 'read_orders'],
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

function chaosDeps(ctx: ChaosContext, store: ChaosShopify): IngestionDeps {
  const db = drizzle(ctx.pool, { schema })
  return {
    db,
    pool: ctx.pool,
    fetcher: { async fetch() { throw new Error('the catalogue sync makes no page fetches') } },
    shopify: {
      authorizeUrl: () => '',
      verifyCallbackSignature: () => true,
      exchangeCode: async () => NO_GRANT,
      refreshAccess: async () => NO_GRANT,
      revokeAccess: async () => {},
    },
    shop: { async getShop() { throw new Error('not used') } },
    admin: store,
    connections: new ChaosConnections(ctx.accountId),
    domains: {
      async findAccountByShopHandle() { return ctx.accountId },
      async setPlatform() {},
      async transition() { return undefined },
      async read() { return 'ingesting' },
      async readNormalized() { return 'chaos.example' },
    },
    now: () => new Date('2026-06-20T03:00:00Z'),
  }
}

export const catalogSyncKilledMidWalk: ChaosScenario = {
  name: 'catalog_sync_killed_mid_walk',

  async setup(pool, accountId) {
    const db = drizzle(pool, { schema })
    await pool.query('DELETE FROM products WHERE account_id = $1', [accountId])
    await pool.query(`DELETE FROM webhook_events WHERE payload ->> 'account_id' = $1`, [accountId])

    // One step, so the harness's "every step settled" assertion is about this
    // one rather than about eight the scenario never runs.
    const { jobId } = await createRun(db, accountId, `chaos-catalog-${Date.now()}`, ['catalog_sync'])
    const step = await findStep(db, jobId, 'catalog_sync')
    state.jobId = jobId
    state.stepId = step!.id
    state.key = deriveIdempotencyKey(accountId, 'catalog_sync', 'chaos-catalog-v1')
    state.requested = []
  },

  async drive(ctx) {
    const db = drizzle(ctx.pool, { schema })

    // The harness kills up to three times in a row, which is more kills than
    // the production retry budget allows before a step dead-letters. The budget
    // has its own test; what is under test here is that each restart resumes
    // rather than starts again, so the attempt counter is reset to let the
    // scenario reach a completed pass.
    await ctx.pool.query(
      `UPDATE job_steps SET attempts = 0, next_attempt_at = NULL WHERE id = $1`,
      [state.stepId],
    )

    const store = new ChaosShopify(ctx)
    const outcome = await runStep({
      db,
      pool: ctx.pool,
      accountId: ctx.accountId,
      jobId: state.jobId,
      stepId: state.stepId,
      idempotencyKey: state.key,
      leaseMs: 0,
      handler: (stepCtx) => catalogSyncStep.execute(chaosDeps(ctx, store), stepCtx),
    })

    // The pass was killed. The step has been settled the way a real failure is
    // settled — checkpoint kept, retry scheduled — and the harness is told, so
    // it re-runs the driver the way a restarted worker would.
    if (store.killedAt !== undefined) throw new WorkerKilled(store.killedAt)

    if (outcome.status !== 'succeeded') {
      // Anything but success here means the kill was not survivable, which is
      // the failure this scenario exists to catch.
      throw new Error(`the catalogue sync did not converge: ${outcome.status}`)
    }
  },

  async assert(ctx) {
    const db = drizzle(ctx.pool, { schema })

    const step = await getStep(db, state.stepId)
    if (step?.state !== 'succeeded') {
      throw new Error(`the step did not converge: ${step?.state}`)
    }

    // Every product, exactly once. The unique index makes duplicates impossible,
    // so the number that matters is "all of them".
    const products = await ctx.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM products WHERE account_id = $1',
      [ctx.accountId],
    )
    if (products.rows[0]?.n !== TOTAL_PRODUCTS) {
      throw new Error(
        `expected ${TOTAL_PRODUCTS} products after the kills; found ${products.rows[0]?.n}`,
      )
    }

    // Every change recorded once. This is the assertion that would fail if a
    // restart re-read pages it had already written and reported them as new.
    const stream = await readCatalogChanges(
      db,
      systemScope('the chaos assertion reads the change stream'),
      ctx.accountId,
      undefined,
      1000,
    )
    const created = stream.changes.filter((change) => change.kind === 'product_created')
    if (created.length !== TOTAL_PRODUCTS) {
      throw new Error(
        `expected ${TOTAL_PRODUCTS} creations in the change stream; found ${created.length}`,
      )
    }
    const distinct = new Set(created.map((change) => change.entityId))
    if (distinct.size !== created.length) {
      throw new Error('a product was reported as created more than once')
    }

    // A restart must not re-read a page it already wrote. Reading the whole
    // store once takes six page requests; if any restart began at page one there
    // would be more requests for page one than passes that legitimately started
    // there — exactly one, the very first.
    const firstPageRequests = state.requested.filter((asked) => asked === 'products:0')
    if (firstPageRequests.length !== 1) {
      throw new Error(
        `the walk restarted from the beginning ${firstPageRequests.length} times; a resume must ` +
          `continue from its saved position`,
      )
    }

    // Exactly one completion record for the work, whatever the kills. This is
    // what a redelivery consults, and what stops the next attempt paying again.
    const ledger = await ctx.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM idempotency_ledger WHERE idempotency_key = $1',
      [state.key],
    )
    if (ledger.rows[0]?.n !== 1) {
      throw new Error(`expected one ledger record for the finished walk; found ${ledger.rows[0]?.n}`)
    }
  },
}

/** Re-exported so the harness's scenario list can stay a list of names. */
export { WorkerKilled }
export type { pg }
