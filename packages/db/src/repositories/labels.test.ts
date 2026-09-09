import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ArticleLabelResult } from '@sortiva/core'
import { articleLabelInputs, ratedArticleLabels, saveArticleLabels } from './labels'
import { insertArticleStub } from './articles'
import { insertMinimalOpportunity } from './opportunities'
import { insertTopic } from './topics'
import { accountScope } from '../scope'
import type { Db } from '../client'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '../testing'

/**
 * The week's verdicts on a store's articles, against a real Postgres.
 *
 * `article_labels` carries no account of its own, so the things most worth
 * proving here are that another store's article id neither reads back nor
 * writes, and that an article the store was not willing to judge leaves no
 * figures behind in the learning loop's own table.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-09-07T00:00:00.000Z')
const WINDOW = { startDate: '2026-08-10', endDate: '2026-09-06' }

describe.skipIf(!available)('article labels', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string
  let otherAccountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('labels_repo')
    db = ctx.db as unknown as Db
  }, 60_000)

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    nextScheduledDay = 0
    accountId = await insertAccount(ctx.pool, 'labels@example.com')
    otherAccountId = await insertAccount(ctx.pool, 'other-labels@example.com')
  })

  // One topic per account per day is enforced in the database, so each article
  // this fixture builds has to take a calendar day of its own.
  let nextScheduledDay = 0

  async function publishedArticle(
    ownerId: string,
    over: {
      readonly override?: boolean
      readonly state?: 'published' | 'draft'
      readonly delivery?: 'auto' | 'export'
      readonly publishedUrl?: string | null
      readonly publishedAt?: string | null
    } = {},
  ): Promise<string> {
    const scope = accountScope(ownerId)
    const opportunity = await insertMinimalOpportunity(
      db,
      scope,
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: `q-${ownerId}-${Math.random()}`,
        evidenceJson: [],
        recommendedAction: 'create',
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
        keywordCluster: null,
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'auto',
        whyLine: 'x',
        scheduledDate: `2026-01-${String((nextScheduledDay++ % 28) + 1).padStart(2, '0')}`,
        pinned: false,
        state: 'published',
      },
      NOW,
    )
    const article = await insertArticleStub(
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
      set state = ${over.state ?? 'published'},
          published_via_override = ${over.override ?? false},
          delivery = ${over.delivery ?? 'auto'},
          published_url = ${
            over.publishedUrl === undefined
              ? `https://shop.example/blogs/news/${article.id}`
              : over.publishedUrl
          },
          published_at = ${over.publishedAt === undefined ? '2026-01-01T00:00:00.000Z' : over.publishedAt}
      where id = ${article.id}
    `)
    return article.id
  }

  function rated(
    articleId: string,
    label: 'winner' | 'neutral' | 'underperformer',
    clicks = 12,
  ): ArticleLabelResult {
    return {
      articleId,
      label,
      ageDays: 200,
      current: { clicks, impressions: 900, position: 8.25 },
      prior: { clicks, impressions: 900, position: 9 },
    }
  }

  function unrated(articleId: string, reason: 'published_via_override'): ArticleLabelResult {
    return { articleId, label: 'unrated', excludedBecause: [reason], ageDays: 200 }
  }

  describe('the facts a verdict is reached from', () => {
    it('reads every article of the store, including the ones that cannot be graded', async () => {
      const ordinary = await publishedArticle(accountId)
      const overridden = await publishedArticle(accountId, { override: true })
      const draft = await publishedArticle(accountId, { state: 'draft', publishedAt: null })

      const inputs = await articleLabelInputs(db, accountScope(accountId))

      expect(inputs).toHaveLength(3)
      expect(inputs.find((row) => row.articleId === ordinary)).toMatchObject({
        published: true,
        publishedViaOverride: false,
        delivery: 'auto',
        repairPending: false,
      })
      expect(inputs.find((row) => row.articleId === overridden)).toMatchObject({
        publishedViaOverride: true,
      })
      expect(inputs.find((row) => row.articleId === draft)).toMatchObject({
        published: false,
        publishedAt: null,
      })
    })

    it('reports an export article with no confirmed address as having none', async () => {
      await publishedArticle(accountId, { delivery: 'export', publishedUrl: null })
      const [row] = await articleLabelInputs(db, accountScope(accountId))
      expect(row).toMatchObject({ delivery: 'export', publishedUrl: null })
    })

    it('reports an open repair against an article, and stops once it is finished', async () => {
      const articleId = await publishedArticle(accountId)
      const scope = accountScope(accountId)
      const repair = await insertMinimalOpportunity(
        db,
        scope,
        {
          signalType: 'broken_product_reference',
          entityType: 'article',
          entityRef: articleId,
          evidenceJson: [],
          recommendedAction: 'fix',
          status: 'accepted',
          reasonTemplateKey: 'broken_product_reference.fix',
          reasonParams: {},
          limitedIntelligence: false,
          rulesVersion: 'test',
        },
        NOW,
      )
      expect((await articleLabelInputs(db, scope))[0]).toMatchObject({ repairPending: true })

      await db.execute(sql`update opportunities set status = 'completed' where id = ${repair.id}`)
      expect((await articleLabelInputs(db, scope))[0]).toMatchObject({ repairPending: false })
    })

    it('does not report another store’s articles', async () => {
      await publishedArticle(otherAccountId)
      expect(await articleLabelInputs(db, accountScope(accountId))).toEqual([])
    })
  })

  describe('recording the week', () => {
    it('stores a graded article’s figures', async () => {
      const articleId = await publishedArticle(accountId)
      const scope = accountScope(accountId)

      expect(await saveArticleLabels(db, scope, WINDOW, [rated(articleId, 'winner')])).toBe(1)

      const rows = await db.execute(
        sql`select label, clicks, impressions, mean_position from article_labels where article_id = ${articleId}`,
      )
      expect(rows.rows).toEqual([
        { label: 'winner', clicks: 12, impressions: 900, mean_position: '8.25' },
      ])
    })

    it('stores an unrated article with no figures at all', async () => {
      // The point of the test: an override-published article's traffic must not
      // end up as a real number in the learning loop's own table, where a later
      // query summing the column would pick it up. The row exists — the verdict
      // "we are not judging this" is worth recording — but the cells are empty.
      const articleId = await publishedArticle(accountId, { override: true })
      const scope = accountScope(accountId)

      expect(
        await saveArticleLabels(db, scope, WINDOW, [unrated(articleId, 'published_via_override')]),
      ).toBe(1)

      const rows = await db.execute(
        sql`select label, clicks, impressions, mean_position from article_labels where article_id = ${articleId}`,
      )
      expect(rows.rows).toEqual([
        { label: 'unrated', clicks: null, impressions: null, mean_position: null },
      ])
    })

    it('corrects last run’s verdict rather than adding a second one for the same weeks', async () => {
      const articleId = await publishedArticle(accountId)
      const scope = accountScope(accountId)

      await saveArticleLabels(db, scope, WINDOW, [rated(articleId, 'neutral')])
      await saveArticleLabels(db, scope, WINDOW, [rated(articleId, 'winner', 40)])

      const rows = await db.execute(
        sql`select label, clicks from article_labels where article_id = ${articleId}`,
      )
      expect(rows.rows).toEqual([{ label: 'winner', clicks: 40 }])
    })

    it('keeps a different set of weeks as a separate verdict', async () => {
      const articleId = await publishedArticle(accountId)
      const scope = accountScope(accountId)

      await saveArticleLabels(db, scope, WINDOW, [rated(articleId, 'neutral')])
      await saveArticleLabels(
        db,
        scope,
        { startDate: '2026-07-13', endDate: '2026-08-09' },
        [rated(articleId, 'winner')],
      )

      const rows = await db.execute(
        sql`select count(*)::int as n from article_labels where article_id = ${articleId}`,
      )
      expect(rows.rows).toEqual([{ n: 2 }])
    })

    it('writes nothing for another store’s article', async () => {
      const theirs = await publishedArticle(otherAccountId)

      expect(await saveArticleLabels(db, accountScope(accountId), WINDOW, [rated(theirs, 'winner')])).toBe(0)

      const rows = await db.execute(sql`select count(*)::int as n from article_labels`)
      expect(rows.rows).toEqual([{ n: 0 }])
    })

    it('writes the store’s own rows even when another store’s article is mixed into the same batch', async () => {
      const ours = await publishedArticle(accountId)
      const theirs = await publishedArticle(otherAccountId)

      expect(
        await saveArticleLabels(db, accountScope(accountId), WINDOW, [
          rated(ours, 'winner'),
          rated(theirs, 'winner'),
        ]),
      ).toBe(1)

      const rows = await db.execute(sql`select article_id from article_labels`)
      expect(rows.rows).toEqual([{ article_id: ours }])
    })
  })

  describe('what pattern learning is handed', () => {
    it('returns the graded articles and not the unrated ones', async () => {
      const winner = await publishedArticle(accountId)
      const overridden = await publishedArticle(accountId, { override: true })
      const scope = accountScope(accountId)

      await saveArticleLabels(db, scope, WINDOW, [
        rated(winner, 'winner'),
        unrated(overridden, 'published_via_override'),
      ])

      const learned = await ratedArticleLabels(db, scope, new Date('2026-06-01T00:00:00.000Z'))
      expect(learned).toEqual([
        {
          articleId: winner,
          label: 'winner',
          windowStart: '2026-08-10',
          windowEnd: '2026-09-06',
          clicks: 12,
          impressions: 900,
          meanPosition: 8.25,
        },
      ])
    })

    it('leaves out verdicts older than the window asked for', async () => {
      const articleId = await publishedArticle(accountId)
      const scope = accountScope(accountId)

      await saveArticleLabels(
        db,
        scope,
        WINDOW,
        [rated(articleId, 'winner')],
        new Date('2026-01-05T00:00:00.000Z'),
      )

      expect(await ratedArticleLabels(db, scope, new Date('2026-06-01T00:00:00.000Z'))).toEqual([])
      expect(await ratedArticleLabels(db, scope, new Date('2025-06-01T00:00:00.000Z'))).toHaveLength(1)
    })

    it('never returns another store’s verdicts', async () => {
      const theirs = await publishedArticle(otherAccountId)
      await saveArticleLabels(db, accountScope(otherAccountId), WINDOW, [rated(theirs, 'winner')])

      expect(
        await ratedArticleLabels(db, accountScope(accountId), new Date('2025-01-01T00:00:00.000Z')),
      ).toEqual([])
    })
  })
})
