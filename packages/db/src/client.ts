import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema'

export type Database = NodePgDatabase<typeof schema>

/** A transaction handle, so repositories can be called inside one (main §14.3.1). */
export type Db = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

let pool: pg.Pool | undefined
let database: Database | undefined

export function createPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set')
  }
  return new pg.Pool({
    connectionString,
    // tech §2.1 — the app service is sized at 512 MB and runs the worker
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

export async function closeDb(): Promise<void> {
  await pool?.end()
  pool = undefined
  database = undefined
}

export { schema }
