import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema'

export type Database = NodePgDatabase<typeof schema>

/** A transaction handle, so repositories can be called inside one. */
export type Db = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

let pool: pg.Pool | undefined
let database: Database | undefined

export function createPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set')
  }
  return new pg.Pool({
    connectionString,
    // The app service is small and runs the worker
    // in-process; a small pool is deliberate, not an oversight.
    max: Number(process.env.PGPOOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
  })
}

export function db(): Database {
  if (!database) {
    pool = createPool()
    database = drizzle(pool, { schema })
  }
  return database
}

/**
 * The pool behind `db()`, for the advisory locks that need a dedicated
 * connection they can hold for the length of a step, rather than a pooled
 * query. Callers that only run queries should use `db()`.
 *
 * Exported because a caller who builds its own pool instead would take locks
 * against a second connection set while its writes went through the first —
 * lock and write must share a database, and sharing the pool is the cheapest
 * way to be sure they do.
 */
export function dbPool(): pg.Pool {
  db()
  return pool!
}

export async function closeDb(): Promise<void> {
  await pool?.end()
  pool = undefined
  database = undefined
}

export { schema }
