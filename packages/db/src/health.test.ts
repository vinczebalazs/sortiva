import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { pingDatabase } from './health'
import { TEST_DATABASE_URL, databaseAvailable } from './testing'

/**
 * The one probe the health check leans on. It has to answer, and it has to fail
 * rather than hang — a probe that hangs is read by the platform as a timeout,
 * which loses the reason.
 */

const available = await databaseAvailable()

describe('pingDatabase', () => {
  it('rejects with the connection error when nothing is listening', async () => {
    const pool = new pg.Pool({
      connectionString: 'postgres://sortiva:sortiva@127.0.0.1:1/sortiva',
      connectionTimeoutMillis: 2_000,
    })
    try {
      await expect(pingDatabase(drizzle(pool))).rejects.toThrow(/ECONNREFUSED/)
    } finally {
      await pool.end().catch(() => {})
    }
  })
})

describe.skipIf(!available)('pingDatabase against a real database', () => {
  let pool: pg.Pool

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL })
  })

  afterAll(async () => {
    await pool.end().catch(() => {})
  })

  it('resolves when the database answers', async () => {
    await expect(pingDatabase(drizzle(pool))).resolves.toBeUndefined()
  })

  it('gives up rather than hanging when the answer does not come in time', async () => {
    // A pool of its own, so the probe has to open a connection first — which
    // cannot finish inside a zero-millisecond budget, however fast the server is.
    const cold = new pg.Pool({ connectionString: TEST_DATABASE_URL })
    try {
      await expect(pingDatabase(drizzle(cold), 0)).rejects.toThrow(/did not answer within/)
    } finally {
      await cold.end().catch(() => {})
    }
  })
})
