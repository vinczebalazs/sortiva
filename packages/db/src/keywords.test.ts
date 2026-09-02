import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { accountScope, systemScope } from './scope'
import {
  BUSINESS_COMPETITOR_CAP,
  CompetitorCapReached,
  addCompetitor,
  addManualKeyword,
  confirmedKeywords,
  countCompetitors,
  keywordsNeedingEnrichment,
  listCompetitors,
  listKeywords,
  removeCompetitor,
  removeKeyword,
  upsertKeywords,
  type KeywordWrite,
} from './repositories/keywords'
import {
  findFreshSerpSnapshot,
  findFreshSerpSnapshots,
  pruneExpiredSerpSnapshots,
  resultsOf,
  upsertSerpSnapshot,
} from './repositories/serp'
import {
  CHECK_VIOLATION,
  databaseAvailable,
  insertAccount,
  pgErrorCode,
  setupTestDb,
  truncateAll,
  type TestDb,
} from './testing'

/**
 * Keywords, competitors and stored results pages against a real Postgres.
 *
 * The case that matters most is the last one in the competitor block: it fills
 * an account to the cap the *code* believes in and then asserts the *database*
 * refuses the next row. That is the only thing keeping the two halves of the
 * five-competitor rule from disagreeing — raise the constant without touching
 * the trigger and this fails.
 */

const available = await databaseAvailable()

const SYSTEM = systemScope('serp snapshots are keyed by request, not by account')

function keyword(over: Partial<KeywordWrite> = {}): KeywordWrite {
  return {
    term: 'trail running shoes',
    language: 'en',
    country: 'GB',
    volume: 900,
    difficulty: 42,
    cpcUsd: 1.25,
    source: 'auto',
    enrichedAt: new Date('2026-09-01T00:00:00Z'),
    ...over,
  }
}

describe.skipIf(!available)('keywords and business competitors', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('keywords')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, 'keywords@example.com')
  })

  describe('the keyword set', () => {
    it('writes the draft set and re-reads it strongest first', async () => {
      const scope = accountScope(accountId)
      await upsertKeywords(ctx.db, scope, [
        keyword({ term: 'trail shoes', volume: 100 }),
        keyword({ term: 'wide fit trail shoes', volume: 900 }),
        keyword({ term: 'unpriced term', volume: null, enrichedAt: null }),
      ])

      const rows = await listKeywords(ctx.db, scope)
      expect(rows.map((row) => row.term)).toEqual([
        'wide fit trail shoes',
        'trail shoes',
        'unpriced term',
      ])
      expect(rows[0]?.cpc).toBe('1.2500')
    })

    it('re-running the same discovery updates the metrics rather than duplicating the term', async () => {
      const scope = accountScope(accountId)
      await upsertKeywords(ctx.db, scope, [keyword({ volume: 100 })])
      await upsertKeywords(ctx.db, scope, [keyword({ volume: 250 })])

      const rows = await listKeywords(ctx.db, scope)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.volume).toBe(250)
    })

    it('adds a hand-typed term unpriced, and adding it twice does not fail', async () => {
      const scope = accountScope(accountId)
      const first = await addManualKeyword(ctx.db, scope, {
        term: 'barefoot trail shoes',
        language: 'en',
        country: 'GB',
      })
      expect(first.source).toBe('manual')
      expect(first.volume).toBeNull()
      expect(first.enrichedAt).toBeNull()

      const again = await addManualKeyword(ctx.db, scope, {
        term: 'barefoot trail shoes',
        language: 'en',
        country: 'GB',
      })
      expect(again.id).toBe(first.id)
      expect(await listKeywords(ctx.db, scope)).toHaveLength(1)
    })

    it('offers for enrichment only the terms nobody has priced lately', async () => {
      const scope = accountScope(accountId)
      await upsertKeywords(ctx.db, scope, [
        keyword({ term: 'fresh', enrichedAt: new Date('2026-09-01T00:00:00Z') }),
        keyword({ term: 'stale', enrichedAt: new Date('2026-06-01T00:00:00Z') }),
        keyword({ term: 'never', enrichedAt: null }),
      ])

      const due = await keywordsNeedingEnrichment(
        ctx.db,
        scope,
        new Date('2026-08-04T00:00:00Z'),
      )
      expect(due.map((row) => row.term)).toEqual(['never', 'stale'])
    })

    it('can be asked about one term only, which is what a hand-typed term needs', async () => {
      const scope = accountScope(accountId)
      await upsertKeywords(ctx.db, scope, [
        keyword({ term: 'one', enrichedAt: null }),
        keyword({ term: 'two', enrichedAt: null }),
      ])
      const due = await keywordsNeedingEnrichment(ctx.db, scope, new Date(), ['two'])
      expect(due.map((row) => row.term)).toEqual(['two'])
    })

    it('reads back only what the merchant confirmed', async () => {
      const scope = accountScope(accountId)
      await upsertKeywords(ctx.db, scope, [keyword({ term: 'a' }), keyword({ term: 'b' })])
      await pool.query(`UPDATE keywords SET confirmed = true WHERE term = 'b'`)
      expect((await confirmedKeywords(ctx.db, scope)).map((r) => r.term)).toEqual(['b'])
    })

    it('removes only this account’s term', async () => {
      const scope = accountScope(accountId)
      await upsertKeywords(ctx.db, scope, [keyword()])
      const [row] = await listKeywords(ctx.db, scope)
      const other = accountScope(await insertAccount(pool, 'other@example.com'))

      expect(await removeKeyword(ctx.db, other, row!.id)).toBe(false)
      expect(await removeKeyword(ctx.db, scope, row!.id)).toBe(true)
      expect(await listKeywords(ctx.db, scope)).toHaveLength(0)
    })
  })

  describe('the five-competitor cap', () => {
    it('refuses the sixth in application code, with its own failure class', async () => {
      const scope = accountScope(accountId)
      for (let i = 1; i <= BUSINESS_COMPETITOR_CAP; i += 1) {
        await addCompetitor(ctx.db, scope, {
          domainNormalized: `rival${i}.example.com`,
          source: 'auto',
        })
      }
      await expect(
        addCompetitor(ctx.db, scope, { domainNormalized: 'rival6.example.com', source: 'manual' }),
      ).rejects.toBeInstanceOf(CompetitorCapReached)
      expect(await countCompetitors(ctx.db, scope)).toBe(BUSINESS_COMPETITOR_CAP)
    })

    it('and the database refuses it too, at the same number', async () => {
      // The point of this case: it fills the account through the repository, at
      // the cap the *code* believes in, then goes round application code
      // entirely. If the constant and the trigger ever name different numbers,
      // one of these two expectations fails.
      const scope = accountScope(accountId)
      for (let i = 1; i <= BUSINESS_COMPETITOR_CAP; i += 1) {
        await addCompetitor(ctx.db, scope, {
          domainNormalized: `rival${i}.example.com`,
          source: 'auto',
        })
      }

      const refused = await pool
        .query(
          `INSERT INTO competitors (account_id, domain_normalized, source) VALUES ($1, $2, 'manual')`,
          [accountId, 'rival6.example.com'],
        )
        .catch((error: unknown) => error)
      expect(pgErrorCode(refused)).toBe(CHECK_VIOLATION)
    })

    it('re-adding a domain already on the list neither fails nor spends a slot', async () => {
      const scope = accountScope(accountId)
      const first = await addCompetitor(ctx.db, scope, {
        domainNormalized: 'rival.example.com',
        source: 'auto',
      })
      const again = await addCompetitor(ctx.db, scope, {
        domainNormalized: 'rival.example.com',
        source: 'manual',
      })
      expect(again.id).toBe(first.id)
      // Still recorded as ours rather than theirs: the row was never re-written.
      expect(again.source).toBe('auto')
      expect(await countCompetitors(ctx.db, scope)).toBe(1)
    })

    it('frees a slot on removal, and refuses to remove another account’s row', async () => {
      const scope = accountScope(accountId)
      for (let i = 1; i <= BUSINESS_COMPETITOR_CAP; i += 1) {
        await addCompetitor(ctx.db, scope, {
          domainNormalized: `rival${i}.example.com`,
          source: 'auto',
        })
      }
      const [first] = await listCompetitors(ctx.db, scope)
      const other = accountScope(await insertAccount(pool, 'other2@example.com'))

      expect(await removeCompetitor(ctx.db, other, first!.id)).toBe(false)
      expect(await removeCompetitor(ctx.db, scope, first!.id)).toBe(true)
      await expect(
        addCompetitor(ctx.db, scope, { domainNormalized: 'rival6.example.com', source: 'manual' }),
      ).resolves.toMatchObject({ domainNormalized: 'rival6.example.com' })
    })
  })

  describe('stored results pages', () => {
    const snapshot = {
      cacheKey: 'dataforseo:serp:abc',
      query: 'trail running shoes',
      locale: 'en-GB',
      results: [
        { position: 1, url: 'https://rival.example/a', domain: 'rival.example', title: 'A' },
      ],
      fetchedAt: new Date('2026-09-01T00:00:00Z'),
      expiresAt: new Date('2026-09-08T00:00:00Z'),
    }

    it('is readable while fresh and invisible once its week is up', async () => {
      await upsertSerpSnapshot(ctx.db, SYSTEM, snapshot)

      const fresh = await findFreshSerpSnapshot(
        ctx.db,
        SYSTEM,
        snapshot.cacheKey,
        new Date('2026-09-05T00:00:00Z'),
      )
      expect(fresh).toBeDefined()
      expect(resultsOf(fresh!)[0]?.domain).toBe('rival.example')

      const stale = await findFreshSerpSnapshot(
        ctx.db,
        SYSTEM,
        snapshot.cacheKey,
        new Date('2026-09-09T00:00:00Z'),
      )
      expect(stale).toBeUndefined()
    })

    it('replaces the reading under one key rather than keeping two', async () => {
      await upsertSerpSnapshot(ctx.db, SYSTEM, snapshot)
      await upsertSerpSnapshot(ctx.db, SYSTEM, {
        ...snapshot,
        results: [
          { position: 1, url: 'https://other.example/a', domain: 'other.example', title: 'B' },
        ],
      })
      const rows = await findFreshSerpSnapshots(
        ctx.db,
        SYSTEM,
        [snapshot.cacheKey],
        new Date('2026-09-05T00:00:00Z'),
      )
      expect(rows).toHaveLength(1)
      expect(resultsOf(rows[0]!)[0]?.domain).toBe('other.example')
    })

    it('is pruned once expired', async () => {
      await upsertSerpSnapshot(ctx.db, SYSTEM, snapshot)
      expect(await pruneExpiredSerpSnapshots(ctx.db, SYSTEM, new Date('2026-09-05T00:00:00Z'))).toBe(
        0,
      )
      expect(await pruneExpiredSerpSnapshots(ctx.db, SYSTEM, new Date('2026-09-09T00:00:00Z'))).toBe(
        1,
      )
    })

    it('holds no account column at all, so a ranking domain cannot belong to a merchant', async () => {
      const { rows } = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'serp_snapshots'`,
      )
      expect(rows.map((r: { column_name: string }) => r.column_name)).not.toContain('account_id')
    })
  })
})
