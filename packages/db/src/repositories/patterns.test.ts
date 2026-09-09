import { aggregatePatterns, labelStore, type ArticleLabelConfig, type ArticleLabelFacts, type PatternConfig } from '@sortiva/core'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { insertArticleStub } from './articles'
import { articleLabelInputs, saveArticleLabels } from './labels'
import { insertMinimalOpportunity } from './opportunities'
import { activePatternStats, patternLearningInputs, savePatternStats } from './patterns'
import { insertTopic } from './topics'
import type { Db } from '../client'
import { accountScope } from '../scope'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '../testing'

/**
 * What a store has learned about the kinds of article that work for it, against
 * a real Postgres.
 *
 * The thing most worth proving here is a refusal rather than an arithmetic
 * result: an article the merchant published over our quality objection must not
 * be able to move a multiplier (invariant 12). So the override tests plant a
 * genuine triumph — three articles with a hundred times the store's typical
 * traffic — and assert nothing comes of it, then plant the identical fixture
 * with the override flag cleared and assert the pattern does appear. Without
 * that second half the first would pass over an inert fixture.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-09-07T00:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const WINDOW = { startDate: '2026-08-10', endDate: '2026-09-06' }
/** The recency window main §9.6.3 bounds pattern learning by, as an instant. */
const SINCE = new Date(NOW.getTime() - 90 * 86_400_000)

const LABEL_CONFIG: ArticleLabelConfig = {
  maturityDays: 28,
  winnerClicksStoreMedianMultipleMin: 2,
  winnerPositionImprovementMin: 5,
  underperformerClicksStoreMedianMultipleMax: 0.25,
  underperformerPositionMin: 30,
  underperformerAgeDaysMin: 90,
}

const PATTERN_CONFIG: PatternConfig = {
  activationMinRated: 3,
  dominanceShareMin: 0.6667,
  winnerDominantMultiplier: 1.25,
  underperformerDominantMultiplier: 0.8,
  mixedMultiplier: 1.0,
  clampMin: 0.5,
  clampMax: 2.0,
  dimensions: ['intent_class', 'family_id', 'keyword_cluster', 'action_type'],
}

describe.skipIf(!available)('pattern stats', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string
  let otherAccountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('patterns_repo')
    db = ctx.db as unknown as Db
  }, 60_000)

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    nextScheduledDay = 0
    accountId = await insertAccount(ctx.pool, 'patterns@example.com')
    otherAccountId = await insertAccount(ctx.pool, 'other-patterns@example.com')
  })

  // One live topic per store per day is enforced in the database, so every
  // article this fixture builds takes a calendar day of its own.
  let nextScheduledDay = 0

  /** The clicks each article is credited with in the window, keyed by article id. */
  const clicksByArticle = new Map<string, number>()

  interface ArticleSpec {
    readonly clicks: number
    readonly intentClass?: 'buying_guide' | 'comparison' | 'how_to' | 'informational'
    readonly action?: 'create' | 'optimize' | 'refresh'
    readonly familyIds?: readonly string[]
    readonly keywordCluster?: string | null
    readonly override?: boolean
  }

  async function insertQueryCluster(ownerId: string, head: string): Promise<string> {
    const { rows } = await ctx.pool.query<{ cluster_id: string }>(
      `INSERT INTO query_clusters (account_id, head_query) VALUES ($1, $2) RETURNING cluster_id`,
      [ownerId, head],
    )
    return rows[0]!.cluster_id
  }

  /**
   * A family id. `topics.family_ids` is a uuid array, which Postgres cannot
   * key to a table, so this is any well-formed uuid rather than a real family
   * row — the aggregation only ever groups on the string.
   */
  const FAMILY_A = '11111111-1111-4111-8111-111111111111'

  async function article(ownerId: string, spec: ArticleSpec): Promise<string> {
    const scope = accountScope(ownerId)
    const opportunity = await insertMinimalOpportunity(
      db,
      scope,
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: `q-${ownerId}-${Math.random()}`,
        evidenceJson: [],
        recommendedAction: spec.action ?? 'create',
        status: 'accepted',
        reasonTemplateKey: 'uncovered_commercial_query.create',
        reasonParams: {},
        limitedIntelligence: false,
        rulesVersion: 'test',
      },
      NOW,
    )
    const topic = await insertTopic(
      db,
      scope,
      {
        opportunityId: opportunity.id,
        title: 'Best trail shoes for wide feet',
        targetKeyword: 'trail shoes wide feet',
        keywordCluster: spec.keywordCluster ?? null,
        intentClass: spec.intentClass ?? 'buying_guide',
        familyIds: spec.familyIds ?? [],
        kind: 'new',
        source: 'auto',
        whyLine: 'x',
        scheduledDate: `2026-01-${String((nextScheduledDay++ % 28) + 1).padStart(2, '0')}`,
        pinned: false,
        state: 'published',
      },
      NOW,
    )
    const stub = await insertArticleStub(
      db,
      scope,
      {
        topicId: topic.id,
        title: 'Best trail shoes for wide feet',
        slug: `trail-shoes-${Math.random()}`,
        targetKeyword: 'trail shoes wide feet',
        state: 'draft',
      },
      NOW,
    )
    await db.execute(sql`
      update articles
      set state = 'published',
          published_via_override = ${spec.override ?? false},
          delivery = 'auto',
          published_url = ${`https://shop.example/blogs/news/${stub.id}`},
          published_at = '2026-01-01T00:00:00.000Z'
      where id = ${stub.id}
    `)
    clicksByArticle.set(stub.id, spec.clicks)
    return stub.id
  }

  /**
   * The real path, end to end: read the store's articles, apply the labelling
   * rule to them, store the verdicts, read back the ones learning may use, roll
   * them up, store the result.
   *
   * Only the Search Console figures are synthetic — they come from a different
   * table with its own suite. Everything that decides which articles count is
   * the shipped code.
   */
  async function recompute(
    ownerId: string,
    window = WINDOW,
    computedAt = NOW,
  ): Promise<number> {
    const scope = accountScope(ownerId)
    const inputs = await articleLabelInputs(db, scope)
    const facts: ArticleLabelFacts[] = inputs.map((input) => {
      const clicks = clicksByArticle.get(input.articleId) ?? 0
      return {
        ...input,
        current: { clicks, impressions: 900, position: 8 },
        prior: { clicks, impressions: 900, position: 8 },
      }
    })
    const { results } = labelStore(facts, LABEL_CONFIG, NOW_ISO)
    await saveArticleLabels(db, scope, window, results, computedAt)

    const learning = await patternLearningInputs(db, scope, SINCE)
    return savePatternStats(db, scope, aggregatePatterns(learning, PATTERN_CONFIG), computedAt)
  }

  /** Every stored row, straight from the table, in the spelling the column holds. */
  async function storedRows(
    ownerId: string,
  ): Promise<{ dimension: string; dimension_value: string; rated_n: number; multiplier: string }[]> {
    const { rows } = await ctx.pool.query(
      `SELECT dimension::text, dimension_value, rated_n, multiplier FROM pattern_stats
       WHERE account_id = $1 ORDER BY dimension, dimension_value`,
      [ownerId],
    )
    return rows
  }

  /**
   * Five quiet articles on one intent class and three loud ones on another. The
   * store's middle article gets one click, so the loud three clear twice it
   * comfortably and are winners — provided anything is willing to judge them.
   */
  async function quietBackground(ownerId: string): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await article(ownerId, { clicks: 1, intentClass: 'informational' })
    }
  }

  describe('an article the merchant published over our objection', () => {
    it('cannot move a multiplier, and the same articles without the override flag do', async () => {
      await quietBackground(accountId)
      for (let i = 0; i < 3; i++) {
        await article(accountId, { clicks: 100, intentClass: 'buying_guide', override: true })
      }
      await recompute(accountId)

      const withOverride = await storedRows(accountId)
      expect(withOverride.find((row) => row.dimension_value === 'buying_guide')).toBeUndefined()

      // The identical store with the flag cleared. If the assertion above were
      // passing because the fixture never had a pattern in it, this would fail.
      await truncateAll(ctx.pool)
      accountId = await insertAccount(ctx.pool, 'patterns@example.com')
      clicksByArticle.clear()
      nextScheduledDay = 0
      await quietBackground(accountId)
      for (let i = 0; i < 3; i++) {
        await article(accountId, { clicks: 100, intentClass: 'buying_guide', override: false })
      }
      await recompute(accountId)

      expect(
        (await storedRows(accountId)).find((row) => row.dimension_value === 'buying_guide'),
      ).toMatchObject({ rated_n: 3, multiplier: '1.2500' })
    })

    it('leaves no trace on the axes it shares with articles that are judged', async () => {
      // The override article is on the same intent class as three ordinary
      // ones. If it counted, the group would be four articles rather than
      // three, and its verdict would tilt the share.
      await quietBackground(accountId)
      for (let i = 0; i < 3; i++) {
        await article(accountId, { clicks: 100, intentClass: 'buying_guide' })
      }
      await article(accountId, { clicks: 0, intentClass: 'buying_guide', override: true })
      await recompute(accountId)

      expect(
        (await storedRows(accountId)).find((row) => row.dimension_value === 'buying_guide'),
      ).toMatchObject({ rated_n: 3, multiplier: '1.2500' })
    })

    it('is refused by the read rather than by a check the aggregation makes', async () => {
      // The refusal is structural: the axes read is fed by `ratedArticleLabels`,
      // which drops every `unrated` verdict, so an override-published article's
      // id never reaches the query that would fetch its axes. This asserts the
      // read returns nothing for such an article; it cannot see a future caller
      // that queries `article_labels` directly instead.
      await article(accountId, { clicks: 100, override: true })
      await recompute(accountId)
      expect(await patternLearningInputs(db, accountScope(accountId), SINCE)).toEqual([])
    })
  })

  describe('one article is one vote', () => {
    it('hands the aggregation every stored verdict, each dated by its own window', async () => {
      const id = await article(accountId, { clicks: 100 })
      await quietBackground(accountId)
      await recompute(accountId, { startDate: '2026-07-13', endDate: '2026-08-09' })
      await recompute(accountId, { startDate: '2026-08-10', endDate: '2026-09-06' })

      const learning = await patternLearningInputs(db, accountScope(accountId), SINCE)
      const forArticle = learning.filter((row) => row.articleId === id)
      expect(forArticle).toHaveLength(2)
      expect(new Set(forArticle.map((row) => row.labelledAt)).size).toBe(2)
    })

    it('does not let one article judged four weeks running become a pattern', async () => {
      // A single article on its own intent class, judged in four windows. Four
      // verdicts, one article, and the activation minimum is three articles.
      await quietBackground(accountId)
      await article(accountId, { clicks: 100, intentClass: 'comparison' })
      for (const [startDate, endDate] of [
        ['2026-06-15', '2026-07-12'],
        ['2026-07-13', '2026-08-09'],
        ['2026-08-10', '2026-09-06'],
        ['2026-05-18', '2026-06-14'],
      ]) {
        await recompute(accountId, { startDate: startDate!, endDate: endDate! })
      }

      expect(
        (await storedRows(accountId)).find((row) => row.dimension_value === 'comparison'),
      ).toBeUndefined()
    })
  })

  describe('the axes a verdict counts towards', () => {
    it('reads them off the topic the article was written from', async () => {
      const cluster = await insertQueryCluster(accountId, 'trail shoes')
      const family = FAMILY_A
      const id = await article(accountId, {
        clicks: 4,
        intentClass: 'how_to',
        action: 'refresh',
        familyIds: [family],
        keywordCluster: cluster,
      })
      await recompute(accountId)

      const [row] = await patternLearningInputs(db, accountScope(accountId), SINCE)
      expect(row?.articleId).toBe(id)
      expect(row?.axes).toEqual(
        expect.arrayContaining([
          { dimension: 'intent_class', value: 'how_to' },
          { dimension: 'action_type', value: 'refresh' },
          { dimension: 'family_id', value: family },
          { dimension: 'keyword_cluster', value: cluster },
        ]),
      )
    })

    it('stores a pattern for every axis the config names, and hands each one back under that name', async () => {
      // Driven from the config rather than a list written here: an axis added
      // to `packages/rules` that this never learns to store fails this.
      const cluster = await insertQueryCluster(accountId, 'trail shoes')
      const family = FAMILY_A
      for (let i = 0; i < 3; i++) {
        await article(accountId, {
          clicks: 1,
          intentClass: 'how_to',
          action: 'refresh',
          familyIds: [family],
          keywordCluster: cluster,
        })
      }
      await recompute(accountId)

      const active = await activePatternStats(db, accountScope(accountId), 3)
      expect([...new Set(active.map((row) => row.dimension))].sort()).toEqual(
        [...PATTERN_CONFIG.dimensions].sort(),
      )
    })

    it('stores the family axis under the name the column accepts and returns the name the config uses', async () => {
      // The database enum spells this axis `family`; `packages/rules` and the
      // multiplier lookup in replenishment both spell it `family_id`. The
      // translation lives in the repository, so this proves both halves of it.
      const family = FAMILY_A
      for (let i = 0; i < 3; i++) {
        await article(accountId, { clicks: 1, familyIds: [family] })
      }
      await recompute(accountId)

      expect((await storedRows(accountId)).map((row) => row.dimension)).toContain('family')
      const active = await activePatternStats(db, accountScope(accountId), 3)
      expect(active.map((row) => row.dimension)).toContain('family_id')
      expect(active.map((row) => row.dimension)).not.toContain('family')
    })
  })

  describe('nothing is learned permanently', () => {
    it('removes a pattern the store no longer supports rather than leaving it standing', async () => {
      await quietBackground(accountId)
      for (let i = 0; i < 3; i++) {
        await article(accountId, { clicks: 100, intentClass: 'buying_guide' })
      }
      await recompute(accountId)
      expect(
        (await storedRows(accountId)).some((row) => row.dimension_value === 'buying_guide'),
      ).toBe(true)

      // The same store as seen through a recency window that reaches nothing.
      const scope = accountScope(accountId)
      const nothingRecent = await patternLearningInputs(db, scope, new Date('2030-01-01T00:00:00.000Z'))
      expect(nothingRecent).toEqual([])
      await savePatternStats(db, scope, aggregatePatterns(nothingRecent, PATTERN_CONFIG), NOW)

      expect(await storedRows(accountId)).toEqual([])
    })

    it('bounds what it learns from by the recency window it is given', async () => {
      await quietBackground(accountId)
      for (let i = 0; i < 3; i++) {
        await article(accountId, { clicks: 100, intentClass: 'buying_guide' })
      }
      // Verdicts computed a year ago.
      await recompute(accountId, WINDOW, new Date('2025-09-07T00:00:00.000Z'))

      expect(await storedRows(accountId)).toEqual([])
    })
  })

  describe('one store\u2019s patterns are its own', () => {
    it('learns nothing from another store’s articles', async () => {
      await quietBackground(otherAccountId)
      for (let i = 0; i < 3; i++) {
        await article(otherAccountId, { clicks: 100, intentClass: 'buying_guide' })
      }
      await recompute(otherAccountId)
      expect((await storedRows(otherAccountId)).length).toBeGreaterThan(0)

      expect(await patternLearningInputs(db, accountScope(accountId), SINCE)).toEqual([])
      expect(await recompute(accountId)).toBe(0)
      expect(await storedRows(accountId)).toEqual([])
      // And the other store's rows survived our empty recompute.
      expect((await storedRows(otherAccountId)).length).toBeGreaterThan(0)
    })

    it('shows a store only its own rows', async () => {
      await quietBackground(otherAccountId)
      for (let i = 0; i < 3; i++) {
        await article(otherAccountId, { clicks: 100, intentClass: 'buying_guide' })
      }
      await recompute(otherAccountId)
      expect(await activePatternStats(db, accountScope(accountId), 3)).toEqual([])
    })
  })

  describe('what the planner is allowed to read', () => {
    it('withholds a group that has not reached the activation minimum', async () => {
      await quietBackground(accountId)
      await recompute(accountId)

      // Five quiet articles are enough for the `informational` group; nothing
      // is enough for a group of one.
      await article(accountId, { clicks: 1, intentClass: 'comparison' })
      await recompute(accountId)

      const stored = await storedRows(accountId)
      expect(stored.some((row) => row.dimension_value === 'comparison')).toBe(false)
      expect(stored.some((row) => row.dimension_value === 'informational')).toBe(true)
    })
  })
})
