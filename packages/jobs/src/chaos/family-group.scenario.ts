import { drizzle } from 'drizzle-orm/node-postgres'
import {
  emptyFactSheet,
  staticShopifyAuth,
  toProductRow,
  type ShopifyAccessGrant,
  type ShopifyAuth,
  type StoreConnection,
} from '@sortiva/core'
import {
  accountScope,
  listFamilies,
  schema,
  upsertProductFacts,
  upsertProducts,
  type Db,
} from '@sortiva/db'
import { familyGroupStep } from '../ingestion/families'
import type { ConnectionStore, IngestionDeps } from '../ingestion/deps'
import { deriveIdempotencyKey } from '../runtime/idempotency'
import { runStep } from '../runtime/runStep'
import { createRun, findStep, getStep } from '../runtime/steps'
import { WorkerKilled, type ChaosContext, type ChaosScenario } from './harness'

/**
 * Killing family grouping right after its one write commits.
 *
 * `families.ts` carries its own note on why this step keeps no checkpoint: it
 * makes no network call, and "the whole reconciliation is one transaction, so
 * a crash leaves the previous families intact rather than a half-regrouped
 * store" (DECISIONS 2026-09-02 T2.4). That sentence is a claim about what
 * happens when the process dies *after* `reconcileFamilies`'s transaction
 * commits but before this step function returns — the step-level ledger row
 * that would have stopped a second attempt from running at all is never
 * written, so the redelivery genuinely re-executes `reconcileFamilies` a
 * second time over the same products. This scenario is where that claim gets
 * to be wrong or right: the two writes have to reconcile onto the *same*
 * families, not double them.
 */

interface State {
  jobId: string
  stepId: string
  key: string
  /** Every time the transaction was seen committing, across every attempt. */
  commits: number
}

const state: State = { jobId: '', stepId: '', key: '', commits: 0 }

/** The grant nothing in this scenario asks for: it never installs anything. */
const NO_GRANT: ShopifyAccessGrant = {
  accessToken: '',
  grantedScopes: [],
  expiresAt: null,
  refreshToken: null,
  refreshTokenExpiresAt: null,
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

/**
 * The real database handle, with one interception: a checkpoint fired *after*
 * `.transaction()` resolves — i.e. after Postgres has committed the families
 * — and before `reconcileFamilies` (and therefore this step) returns. Every
 * other call passes straight through, so the read that runs before the write
 * behaves exactly as it does in production.
 */
function withCommitCheckpoint(db: Db, ctx: ChaosContext): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        // `Db` is a union of drizzle's top-level handle and its transaction
        // handle, so `Parameters<Db['transaction']>` does not resolve to a
        // usable tuple. This is chaos-only plumbing around a third-party
        // type, not product logic, so it is typed loosely on purpose.
        const real = (Reflect.get(target, prop, receiver) as (...a: unknown[]) => Promise<unknown>).bind(
          target,
        )
        return async (...args: unknown[]) => {
          const result = await real(...args)
          // Thrown after the commit above has already happened — the point
          // this scenario exists to test.
          ctx.checkpoint('after-reconcile-commit')
          return result
        }
      }
      // Bound to `target`, not returned as a bare reference: drizzle's own
      // object almost certainly closes over private fields, and a method
      // called as `proxy.select()` would otherwise run with `this` set to the
      // Proxy rather than the real instance and throw on the first private
      // field it touches.
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as Db
}

function baseDeps(ctx: Pick<ChaosContext, 'pool' | 'accountId'>): IngestionDeps {
  return {
    db: drizzle(ctx.pool, { schema }),
    pool: ctx.pool,
    fetcher: { async fetch() { throw new Error('grouping makes no page fetches') } },
    shopify: {
      authorizeUrl: () => '',
      verifyCallbackSignature: () => true,
      exchangeCode: async () => NO_GRANT,
      refreshAccess: async () => NO_GRANT,
      revokeAccess: async () => {},
    },
    shop: { async getShop() { throw new Error('not used') } },
    connections: new ChaosConnections(ctx.accountId),
    domains: {
      async findAccountByShopHandle() { return ctx.accountId },
      async setPlatform() {},
      async transition() { return undefined },
      async read() { return 'ingesting' },
      async readNormalized() { return 'chaos.example' },
    },
  }
}

const PRODUCT_COUNT = 4

export const familyGroupKilledAfterCommit: ChaosScenario = {
  name: 'family_group_killed_after_commit',
  // A clean pass reaches exactly one checkpoint — the single commit. Telling
  // the harness so up front is not optional here the way it is for a
  // many-checkpoint scenario: at the default guess of 8, a first draw has only
  // a 1-in-8 chance of landing on it, and every miss fully finishes the step,
  // which settles the ledger and leaves nothing left for any retry to
  // interrupt — so left at the default, this scenario would silently report
  // zero kills seven times out of eight.
  initialCeiling: 1,

  async setup(pool, accountId) {
    const db = drizzle(pool, { schema })
    // `product_facts` carries no account column of its own — it cascades from
    // `products` — so deleting the products is enough to clear both.
    await pool.query('DELETE FROM products WHERE account_id = $1', [accountId])
    await pool.query('DELETE FROM product_families WHERE account_id = $1', [accountId])

    const scope = accountScope(accountId)
    const rows = Array.from({ length: PRODUCT_COUNT }, (_unused, i) => ({
      id: String(i + 1),
      title: `Chaos Trail Shoe ${i + 1}`,
      product_type: 'Shoes',
      tags: '',
      updated_at: '2026-06-14T10:00:00Z',
    }))
    await upsertProducts(db, scope, rows.map(toProductRow), new Date('2026-06-14T10:00:00Z'))

    const ids = await pool.query<{ id: string }>(
      'SELECT id FROM products WHERE account_id = $1 ORDER BY shopify_product_id',
      [accountId],
    )
    for (const { id } of ids.rows) {
      await upsertProductFacts(db, scope, {
        productId: id,
        factSheet: emptyFactSheet(),
        fluffDiscarded: true,
        promptVersion: 'distill.v1',
        modelId: 'claude-haiku-test',
      })
    }

    const { jobId } = await createRun(db, accountId, `chaos-family-${Date.now()}`, ['family_group'])
    const step = await findStep(db, jobId, 'family_group')
    state.jobId = jobId
    state.stepId = step!.id
    state.key = deriveIdempotencyKey(
      accountId,
      'family_group',
      await familyGroupStep.inputVersion(baseDeps({ pool, accountId }), accountId),
    )
    state.commits = 0
  },

  async drive(ctx) {
    const db = withCommitCheckpoint(drizzle(ctx.pool, { schema }), ctx)

    await ctx.pool.query(
      `UPDATE job_steps SET attempts = 0, next_attempt_at = NULL WHERE id = $1`,
      [state.stepId],
    )

    let killed = false
    const outcome = await runStep({
      db,
      pool: ctx.pool,
      accountId: ctx.accountId,
      jobId: state.jobId,
      stepId: state.stepId,
      idempotencyKey: state.key,
      leaseMs: 0,
      handler: async (stepCtx) => {
        try {
          const result = await familyGroupStep.execute({ ...baseDeps(ctx), db }, stepCtx)
          state.commits += 1
          return result
        } catch (error) {
          if (error instanceof WorkerKilled) {
            state.commits += 1
            killed = true
          }
          throw error
        }
      },
    })

    if (killed) throw new WorkerKilled('after-reconcile-commit')

    if (outcome.status !== 'succeeded') {
      throw new Error(`family grouping did not converge: ${outcome.status}`)
    }
  },

  async assert(ctx) {
    const db = drizzle(ctx.pool, { schema })

    const step = await getStep(db, state.stepId)
    if (step?.state !== 'succeeded') {
      throw new Error(`the step did not converge: ${step?.state}`)
    }

    // The commit happened at least once (the kill fires *after* it) and, if a
    // kill occurred, a second time on the redelivery — reconciling onto the
    // same row rather than a duplicate.
    if (state.commits < 1) {
      throw new Error('the reconciling transaction never committed')
    }

    const families = await listFamilies(db, accountScope(ctx.accountId))
    if (families.length !== 1) {
      throw new Error(
        `expected exactly one family from ${PRODUCT_COUNT} same-type products; found ${families.length} — a redelivery duplicated the write`,
      )
    }
    if (families[0]?.memberCount !== PRODUCT_COUNT) {
      throw new Error(
        `expected the family to hold all ${PRODUCT_COUNT} products; it holds ${families[0]?.memberCount}`,
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
