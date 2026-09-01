import { randomBytes } from 'node:crypto'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { fileURLToPath } from 'node:url'
import * as schema from './schema'

/**
 * Integration-test harness. tech §5 puts a Postgres 16 service in CI and
 * docker-compose locally; these tests exercise real constraints, because a
 * constraint asserted in TypeScript is not a constraint.
 */

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url))

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://sortiva:sortiva@localhost:54329/sortiva'

export interface TestDb {
  db: NodePgDatabase<typeof schema>
  pool: pg.Pool
  /** The isolated database this suite owns. */
  databaseName: string
  close: () => Promise<void>
}

/** True when a Postgres reachable at TEST_DATABASE_URL exists. */
/**
 * Whether a Postgres the tests can use is reachable.
 *
 * Locally this returns false and the suite skips, so someone can run the unit
 * tests without Docker. **In CI it throws instead**, because a skip is green:
 * without this, a CI database that failed to start would take every
 * database-backed suite out of the run and the build would still pass.
 *
 * This is enforced here rather than left to each suite. Five suites wrote that
 * assertion by hand and seven did not, which is exactly how a convention decays —
 * the seven were not careless, they simply never saw the pattern, which lives in
 * a package they do not own. A rule every caller has to remember is a rule that
 * holds until someone new writes the next suite.
 */
export async function databaseAvailable(): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 2000 })
  try {
    await pool.query('select 1')
    return true
  } catch (error) {
    if (process.env.CI) {
      throw new Error(
        `No Postgres at ${TEST_DATABASE_URL}. Database-backed tests must not be skipped in CI — ` +
          `a skipped suite reports green while proving nothing. ` +
          `Cause: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return false
  } finally {
    await pool.end().catch(() => {})
  }
}

/**
 * Creates a database of this suite's own, applies every committed migration,
 * and hands back a connection to it.
 *
 * Per-suite isolation rather than one shared database: vitest runs test files
 * in parallel, and two suites truncating the same tables produce failures that
 * look like constraint bugs and are not. `label` must be unique per test file.
 */
/**
 * A suffix unique to this process, so two test runs cannot own the same database.
 *
 * The names used to be fixed constants, and every suite began by force-dropping
 * its database — which disconnects whoever is attached. Two runs a second apart
 * therefore destroyed each other: one passed, the other failed with "terminating
 * connection due to administrator command", or skipped wholesale because the
 * connection probe timed out. That is what made a fifth of the suite quietly not
 * run (`docs/audits/false-confidence.md`, finding 3) — and a skipped test is
 * green, so every other result was provisional.
 */
const RUN_SUFFIX = randomBytes(4).toString('hex')

export async function setupTestDb(label: string): Promise<TestDb> {
  const slug = label.replace(/[^a-z0-9]+/gi, '_').toLowerCase()
  const databaseName = `sortiva_test_${slug}_${RUN_SUFFIX}`

  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL })
  try {
    // No blanket drop: this name belongs to this run and nothing else can hold it.
    await admin.query(`CREATE DATABASE "${databaseName}"`)
  } finally {
    await admin.end()
  }

  const url = new URL(TEST_DATABASE_URL)
  url.pathname = `/${databaseName}`
  const pool = new pg.Pool({ connectionString: url.toString() })
  const db = drizzle(pool, { schema })
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })

  return {
    db,
    pool,
    databaseName,
    close: async () => {
      await pool.end()
      // Drop what this run created. Previously nothing did, and the next run's
      // force-drop was the cleanup — which is what made runs destroy each other.
      // FORCE here only ever targets this run's own database, and it also clears
      // a connection a suite forgot to close.
      const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL })
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
      } catch {
        // A leftover database is untidy, not a failure — never fail a green run
        // on cleanup. `pnpm db:down && pnpm db:up` clears any that accumulate.
      } finally {
        await admin.end()
      }
    },
  }
}

/** Every wave-1 table, child-first, so truncation between tests is total. */
const WAVE_1_TABLES = [
  'notifications',
  'email_sends',
  'notification_prefs',
  'email_suppressions',
  'job_steps',
  'ingestion_jobs',
  'ops_flags',
  'request_cache',
  'webhook_events',
  'stripe_events',
  'preview_cache',
  'shopify_conns',
  'domains',
  'subscriptions',
  'account_settings',
  'accounts',
] as const

/** Every wave-2 table (T2.0), child-first, on the same terms. */
const WAVE_2_TABLES = [
  'spend_events',
  'landing_revenue_daily',
  'rules_overrides',
  'dismissed_opportunities',
  'signal_runs',
  'optimize_recommendations',
  'opportunity_tasks',
  'opportunities',
  'serp_snapshots',
  'ctr_curve',
  'query_clusters',
  'gsc_query_daily',
  'gsc_daily',
  'gsc_conns',
  'store_pages',
  'competitors',
  'keywords',
  'top_products',
  'personas',
  'product_facts',
  'products',
  'product_families',
] as const

/** Schema mini-wave 2b (T2.0b). Neither table references anything. */
const WAVE_2B_TABLES = ['idempotency_ledger', 'verification_tokens'] as const

const ALL_TABLES = [...WAVE_2B_TABLES, ...WAVE_2_TABLES, ...WAVE_1_TABLES] as const

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE ${ALL_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  )
}

export async function insertAccount(pool: pg.Pool, email: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO accounts (email) VALUES ($1) RETURNING id',
    [email],
  )
  return rows[0]!.id
}

/** Postgres unique-violation. Asserting on the code beats asserting on a message. */
export const UNIQUE_VIOLATION = '23505'
export const CHECK_VIOLATION = '23514'
export const NOT_NULL_VIOLATION = '23502'
/** What `spend_events`' append-only trigger raises (migration 0003). */
export const RESTRICT_VIOLATION = '23001'

export function pgErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}
