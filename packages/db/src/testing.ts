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
export async function databaseAvailable(): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 2000 })
  try {
    await pool.query('select 1')
    return true
  } catch {
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
export async function setupTestDb(label: string): Promise<TestDb> {
  const databaseName = `sortiva_test_${label.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`

  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL })
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
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
