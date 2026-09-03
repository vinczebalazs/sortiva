import { drizzle } from 'drizzle-orm/node-postgres'
import { silentLogger } from '@sortiva/core'
import { accountScope, listOpenOpportunities, listSignalRuns, schema } from '@sortiva/db'
import { MockSeoDataProvider } from '@sortiva/providers/seo/mock'
import { runSignalScan } from '../scan/run'
import type { ChaosScenario } from './harness'

/**
 * `T3.7`'s own chaos case: kill the signal scan mid-pass and prove a fresh
 * re-run converges.
 *
 * `runSignalScan`'s own doc comment states the design this scenario exists to
 * test: no interior checkpoint, because every write the pass makes is already
 * naturally idempotent (`upsertOpportunity`'s `ON CONFLICT`, tasks written
 * only on first sighting, guarded status transitions, guarded expiry), and
 * `signal_runs` itself is written exactly once, at the very end. A kill at
 * any point during the persist loop should therefore leave the database in a
 * state a completely fresh pass — not a resumed one — reconciles onto
 * exactly, with no duplicate rows and no double-counted `signal_runs` totals.
 */

const NOW = new Date('2026-09-07T07:00:00Z')
const RUN_ID = 'weekly-chaos-2026-W36'

const PAGES = [
  { url: 'https://chaos.example/collections/a', title: 'A' },
  { url: 'https://chaos.example/collections/b', title: 'B' },
  { url: 'https://chaos.example/collections/c', title: 'C' },
]

export const signalScanKilledMidPass: ChaosScenario = {
  name: 'signal_scan_killed_mid_pass',

  async setup(pool, accountId) {
    await pool.query('DELETE FROM store_pages WHERE account_id = $1', [accountId])
    await pool.query('DELETE FROM opportunities WHERE account_id = $1', [accountId])
    await pool.query('DELETE FROM signal_runs WHERE account_id = $1', [accountId])

    const db = drizzle(pool, { schema })
    const scope = accountScope(accountId)
    const { upsertStorePages } = await import('@sortiva/db')
    await upsertStorePages(
      db,
      scope,
      PAGES.map((page, i) => ({
        url: page.url,
        pageType: 'collection' as const,
        handle: page.title.toLowerCase(),
        shopifyId: `gid://shopify/Collection/${i + 1}`,
        title: page.title,
        // Every page is missing both fields — three real opportunities to
        // persist, three real points a kill can land between.
        seoTitle: null,
        seoDescription: null,
        headings: [],
        bodyHtml: null,
        outboundInternalLinks: [],
        familyIds: [],
        checksum: `chaos-${i}`,
      })),
    )
  },

  // Three real checkpoints (one per page's opportunity persisted) — declared
  // so the harness's first draw lands inside range rather than overshooting a
  // three-step run on the first attempt.
  initialCeiling: 3,

  async drive(ctx) {
    const db = drizzle(ctx.pool, { schema })

    // `ctx.checkpoint` itself throws `WorkerKilled` at the chosen point; it
    // propagates straight up through this call, through `runSignalScan`'s own
    // stack (including `withAccountLock`'s lock-release `finally`), and out
    // here unmodified — nothing in this scenario needs to catch it itself.
    await runSignalScan(
      {
        db,
        pool: ctx.pool,
        seo: new MockSeoDataProvider({}),
        capture: { capture: () => {} },
        now: () => NOW,
        logger: silentLogger,
        onOpportunityPersisted: (entityRef) => ctx.checkpoint(`persisted:${entityRef}`),
      },
      ctx.accountId,
      'weekly',
      RUN_ID,
    )
  },

  async assert(ctx) {
    const db = drizzle(ctx.pool, { schema })
    const scope = accountScope(ctx.accountId)

    const open = await listOpenOpportunities(db, scope)
    const metadataRows = open.filter((row) => row.signalType === 'missing_or_weak_metadata')
    if (metadataRows.length !== PAGES.length) {
      throw new Error(
        `expected exactly one open metadata opportunity per page (${PAGES.length}); found ${metadataRows.length} — a redelivery duplicated or dropped one`,
      )
    }

    // Dedupe on (signal_type, entity_ref) is the whole guarantee: no page's
    // opportunity should exist twice.
    const seen = new Set<string>()
    for (const row of metadataRows) {
      const key = `${row.signalType}:${row.entityRef}`
      if (seen.has(key)) throw new Error(`duplicate opportunity row for ${key} — a kill mid-pass was not idempotent`)
      seen.add(key)
    }

    const runs = await listSignalRuns(db, scope, 'weekly')
    const run = runs.find((r) => r.runId === RUN_ID)
    if (!run || !run.finishedAt) {
      throw new Error('the signal run never finished — a kill mid-pass left signal_runs unwritten')
    }
    // The *surviving* pass's own counts — the one that actually reached the
    // end and wrote `signal_runs` — must account for every page exactly
    // once, split between "created" (never persisted by an earlier, killed
    // attempt) and "updated" (a killed attempt already got there first, so
    // this pass's own `upsertOpportunity` call reconciled onto that row
    // rather than inserting a second one). Either split is correct; every
    // page missing from both is not.
    if (run.opportunitiesCreated + run.opportunitiesUpdated !== PAGES.length) {
      throw new Error(
        `expected the surviving pass to account for all ${PAGES.length} pages (created + updated); ` +
          `found created=${run.opportunitiesCreated} updated=${run.opportunitiesUpdated}`,
      )
    }
  },
}
