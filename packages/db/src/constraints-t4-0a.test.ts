import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { databaseAvailable, insertAccount, pgErrorCode, setupTestDb, truncateAll, type TestDb } from './testing'

/**
 * T4.0a done-when: "the migration applies forward, every existing
 * `store_pages` row reads as live, and a constraint test proves the field
 * cannot hold a value outside the named set."
 *
 * This is a migration-only mini-wave: `store_pages.status` records which
 * condition a row is in (live or gone — see `DECISIONS.md`, 2026-09-03,
 * FOUNDER) but nothing writes `gone` or reads the column yet. These tests
 * only prove the column's shape, against a real Postgres, the same way
 * `constraints-wave2.test.ts` and `constraints-wave3.test.ts` do for the
 * rest of this table.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('store_pages.status (T4.0a — a store page can be recorded as gone)', () => {
  let ctx: TestDb
  let pool: pg.Pool

  beforeAll(async () => {
    ctx = await setupTestDb('constraints_t4_0a')
    pool = ctx.pool
  }, 60_000)

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
  })

  it('defaults an existing row to live when status is not supplied', async () => {
    const a = await insertAccount(pool, 'a@example.com')
    await pool.query(`INSERT INTO store_pages (account_id, url, page_type) VALUES ($1,'/a','collection')`, [a])
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM store_pages WHERE account_id = $1`,
      [a],
    )
    expect(rows[0]!.status).toBe('live')
  })

  it('accepts the other named condition, gone', async () => {
    const a = await insertAccount(pool, 'a@example.com')
    await pool.query(
      `INSERT INTO store_pages (account_id, url, page_type, status) VALUES ($1,'/a','collection','gone')`,
      [a],
    )
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM store_pages WHERE account_id = $1`,
      [a],
    )
    expect(rows[0]!.status).toBe('gone')
  })

  it('rejects a status outside the named set (live, gone)', async () => {
    const a = await insertAccount(pool, 'a@example.com')
    const rejected = await pool
      .query(
        `INSERT INTO store_pages (account_id, url, page_type, status) VALUES ($1,'/a','collection','deleted')`,
        [a],
      )
      .catch((e) => e)
    // A native Postgres enum refuses an unknown label as invalid input, not as a named
    // constraint code — the same shape store_page_type already has on this table
    // (constraints-wave2.test.ts, "rejects a signal type that names no entry...").
    expect(pgErrorCode(rejected)).toBe('22P02')
  })

  it('rejects a null status', async () => {
    const a = await insertAccount(pool, 'a@example.com')
    const rejected = await pool
      .query(`INSERT INTO store_pages (account_id, url, page_type, status) VALUES ($1,'/a','collection',NULL)`, [a])
      .catch((e) => e)
    expect(pgErrorCode(rejected)).toBe('23502')
  })
})
