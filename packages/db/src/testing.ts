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

/** Applies every committed migration, then hands back a connected database. */
export async function setupTestDb(): Promise<TestDb> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL })
  const db = drizzle(pool, { schema })
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
  return {
    db,
    pool,
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

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE ${WAVE_1_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
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

export function pgErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}
