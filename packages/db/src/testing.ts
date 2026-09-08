import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { fileURLToPath } from 'node:url'
import * as schema from './schema'

/**
 * Integration-test harness. There is a Postgres 16 service in CI and
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

/**
 * One connection set per test process for everything that talks to the server
 * itself rather than to a suite's own database — the reachability probe,
 * creating a database, dropping it.
 *
 * It used to be a fresh pool for each of those, three per suite. That matters
 * because the server has a hard ceiling on how many clients may be connected at
 * once (100 by default), and several test runs at once share it: once the
 * ceiling is reached the server refuses everything, including the probe, and a
 * refused probe used to read as "no database" and skip the suite silently.
 *
 * Kept on the process rather than in this module, because the test runner loads
 * this module afresh for every test file it runs in a worker. A plain
 * module-level variable therefore means a separate connection per file rather
 * than per process, and two of them overlap whenever one file follows another.
 *
 * `allowExitOnIdle` lets a worker process exit without waiting for these to time
 * out, so nothing hangs at the end of a run.
 */
const ADMIN_POOL = Symbol.for('sortiva.testing.admin-pool')
type ProcessWithAdminPool = typeof globalThis & { [ADMIN_POOL]?: pg.Pool }

function admin(): pg.Pool {
  const host = globalThis as ProcessWithAdminPool
  host[ADMIN_POOL] ??= new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    // One. Every use of it here is a single statement awaited on its own, so a
    // second connection would buy nothing and cost a slot that another test
    // process needs.
    max: 1,
    // Handed back almost immediately. This connection is only wanted for the
    // moment it takes to create or drop a database; left open between suites it
    // becomes one permanently occupied slot per worker process, which across
    // several test runs at once is most of the server's capacity spent on
    // connections that are doing nothing.
    idleTimeoutMillis: 500,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  })
  return host[ADMIN_POOL]
}

/** Nothing is listening at all — as opposed to a server that answered. */
function nothingIsListening(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN'
}

/**
 * Whether a Postgres the tests can use is reachable.
 *
 * Locally this returns false and the suite skips **only when nothing is
 * listening on the port**, so someone can run the unit tests without Docker.
 * **In CI it throws instead**, because a skip is green: without this, a CI
 * database that failed to start would take every database-backed suite out of
 * the run and the build would still pass.
 *
 * Any other answer throws, everywhere. A server that is up but refusing — out
 * of connection slots, still starting, rejecting the password — used to be
 * indistinguishable here from "no Docker", so heavy load quietly removed whole
 * suites from the run and the run still reported green. That is a worse failure
 * than a red one, because nobody goes looking.
 *
 * This is enforced here rather than left to each suite. Five suites wrote that
 * assertion by hand and seven did not, which is exactly how a convention decays —
 * the seven were not careless, they simply never saw the pattern, which lives in
 * a package they do not own. A rule every caller has to remember is a rule that
 * holds until someone new writes the next suite.
 */
export async function databaseAvailable(): Promise<boolean> {
  try {
    await admin().query('select 1')
    return true
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    if (nothingIsListening(error)) {
      if (process.env.CI) {
        throw new Error(
          `No Postgres at ${TEST_DATABASE_URL}. Database-backed tests must not be skipped in CI — ` +
            `a skipped suite reports green while proving nothing. Cause: ${cause}`,
        )
      }
      return false
    }
    throw new Error(
      `Postgres at ${TEST_DATABASE_URL} answered but would not take a connection, so this suite ` +
        `cannot run. It is not being skipped: a skip would report green while proving nothing. ` +
        `Cause: ${cause}`,
    )
  }
}

/**
 * A suffix unique to each loading of this module — in practice one per test
 * file — so two test runs cannot own the same database.
 *
 * The names used to be fixed constants, and every suite began by force-dropping
 * its database — which disconnects whoever is attached. Two runs a second apart
 * therefore destroyed each other: one passed, the other failed with "terminating
 * connection due to administrator command", or skipped wholesale because the
 * connection probe timed out. That is what made a fifth of the suite quietly not
 * run — and a skipped test is green, so every other result was provisional.
 */
const RUN_SUFFIX = randomBytes(4).toString('hex')

function urlFor(databaseName: string): string {
  const url = new URL(TEST_DATABASE_URL)
  url.pathname = `/${databaseName}`
  return url.toString()
}

/**
 * Identifies the migration set, so a template built from an older set is never
 * reused after someone adds a migration. Changing any migration file, or adding
 * one, changes this and the next run builds a fresh template.
 */
function migrationsFingerprint(): string {
  const hash = createHash('sha256')
  for (const file of readdirSync(MIGRATIONS_FOLDER).sort()) {
    if (!file.endsWith('.sql')) continue
    hash.update(file)
    hash.update(readFileSync(join(MIGRATIONS_FOLDER, file)))
  }
  return hash.digest('hex').slice(0, 12)
}

/**
 * A database that already has every migration applied, kept so each suite can
 * be stamped out of it instead of migrating from scratch.
 *
 * Running the whole migration set once per suite was the single biggest cost in
 * the harness — a hundred suites each replaying every migration, times however
 * many test runs are going at once. Two things came of that: the setup hook
 * routinely blew its ten-second budget under load, which fails the *file*
 * rather than any test; and the sheer volume of writing made every later
 * clean-up slow, because dropping a database in Postgres forces the whole
 * server to flush everything it is holding before it can proceed. Copying a
 * ready-made database is a file copy and costs a fraction of it.
 *
 * Building it is guarded by a lock held on the server, not in this process, so
 * that concurrent test runs — separate processes, separate working copies —
 * build it once between them rather than once each. It is built under a
 * throwaway name and renamed only when complete, so a half-built one is never
 * mistaken for a finished one.
 */
const TEMPLATE_BUILD_LOCK = 4_713_452_901
let templatePromise: Promise<string> | undefined

async function buildTemplate(templateName: string): Promise<void> {
  const client = await admin().connect()
  try {
    await client.query('select pg_advisory_lock($1)', [TEMPLATE_BUILD_LOCK])
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [
      templateName,
    ])
    if (rowCount) return

    const building = `${templateName}_building_${RUN_SUFFIX}`
    await client.query(`DROP DATABASE IF EXISTS "${building}" WITH (FORCE)`)
    await client.query(`CREATE DATABASE "${building}"`)
    try {
      const pool = new pg.Pool({ connectionString: urlFor(building), max: 1 })
      try {
        await migrate(drizzle(pool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER })
      } finally {
        await pool.end()
      }
      await client.query(`ALTER DATABASE "${building}" RENAME TO "${templateName}"`)
    } catch (error) {
      await client.query(`DROP DATABASE IF EXISTS "${building}" WITH (FORCE)`).catch(() => {})
      throw error
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [TEMPLATE_BUILD_LOCK]).catch(() => {})
    client.release()
  }
}

/**
 * Builds the migrated template up front, so no suite pays for it inside its own
 * setup budget. Called once per run from vitest's global setup.
 */
export async function prepareTestTemplate(): Promise<void> {
  await templateDatabase()
}

function templateDatabase(): Promise<string> {
  templatePromise ??= (async () => {
    const name = `sortiva_test_template_${migrationsFingerprint()}`
    await buildTemplate(name)
    return name
  })().catch((error: unknown) => {
    templatePromise = undefined
    throw error
  })
  return templatePromise
}

/** Whoever is still attached to a database, in a form worth printing. */
async function backendsOn(databaseName: string): Promise<string[]> {
  const { rows } = await admin().query<{ detail: string }>(
    `select pid || ' (' || coalesce(state, 'unknown') || '): ' || left(coalesce(query, ''), 200)
       as detail
       from pg_stat_activity
      where datname = $1`,
    [databaseName],
  )
  return rows.map((row) => row.detail)
}

/**
 * Creates a database of this suite's own from the migrated template and hands
 * back a connection to it.
 *
 * Per-suite isolation rather than one shared database: vitest runs test files
 * in parallel, and two suites truncating the same tables produce failures that
 * look like constraint bugs and are not. `label` must be unique per test file.
 */
export async function setupTestDb(label: string): Promise<TestDb> {
  const slug = label.replace(/[^a-z0-9]+/gi, '_').toLowerCase()
  const databaseName = `sortiva_test_${slug}_${RUN_SUFFIX}`

  const template = await templateDatabase()
  // No blanket drop: this name belongs to this run and nothing else can hold it.
  await admin().query(`CREATE DATABASE "${databaseName}" TEMPLATE "${template}"`)

  const pool = new pg.Pool({
    connectionString: urlFor(databaseName),
    // How many a test may hold at once is unchanged — a suite that fires eight
    // requests at once still gets eight real connections. They are just handed
    // back sooner afterwards, instead of sitting idle for ten seconds while
    // other test processes are refused for want of a slot.
    idleTimeoutMillis: 500,
    allowExitOnIdle: true,
  })
  const db = drizzle(pool, { schema })

  return {
    db,
    pool,
    databaseName,
    close: async () => {
      await pool.end()

      // Anything still attached here is a connection the suite opened and never
      // closed. It has to be named out loud: the drop below would otherwise kill
      // it, and the error that produced surfaced asynchronously, with no test and
      // no file attached to it, so it landed on whichever suite happened to be
      // running at that instant. Reported here it points at the suite that leaked.
      //
      // Re-checked for a couple of seconds first, because a connection the suite
      // did close vanishes from the server's list a moment after the socket goes,
      // and reporting that as a leak would be a lie in the other direction. One
      // that is genuinely leaked is still there every time.
      let leaked = await backendsOn(databaseName)
      for (let attempt = 0; leaked.length > 0 && attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        leaked = await backendsOn(databaseName)
      }

      try {
        await admin().query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
      } catch {
        // A leftover database is untidy, not a failure — never fail a green run
        // on cleanup. `pnpm db:down && pnpm db:up` clears any that accumulate.
      }

      if (leaked.length > 0) {
        throw new Error(
          `${label} left ${leaked.length} connection(s) open on its test database after close(). ` +
            `Close every pool, worker and client the suite opens. Still attached:\n` +
            leaked.map((detail) => `  - ${detail}`).join('\n'),
        )
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

/** Schema wave 3 (T4.0), child-first, on the same terms. */
const WAVE_3_TABLES = [
  'gate_decisions',
  'article_claims',
  'article_labels',
  'article_product_refs',
  'refresh_log',
  'publish_intents',
  'not_interested',
  'pattern_stats',
  'articles',
  'topics',
  'gsc_monthly',
  'gsc_query_monthly',
  'incident_findings',
  'deletion_confirmation_emails',
] as const

/** Schema mini-wave 5 (T-WAVE5). One table, which references `accounts`. */
const WAVE_5_TABLES = ['sessions'] as const

const ALL_TABLES = [
  ...WAVE_5_TABLES,
  ...WAVE_3_TABLES,
  ...WAVE_2B_TABLES,
  ...WAVE_2_TABLES,
  ...WAVE_1_TABLES,
] as const

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
export const FOREIGN_KEY_VIOLATION = '23503'
/** What `spend_events`' append-only trigger raises (migration 0003). */
export const RESTRICT_VIOLATION = '23001'

export function pgErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}
