import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { RECOVERY_GRACE_MS, publishMarker, silentLogger } from '@sortiva/core'
import {
  accountScope,
  dismissOpportunityGuarded,
  listOpenOpportunities,
  markArticleDelivered,
  schema,
  setDeliveryMode,
  setTargetBlog,
  type Db,
} from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { FakeShopifyPublishClient } from '@sortiva/providers'
import { publishArticleToShopify } from './auto-publish'
import { dismissOpportunity } from '../generation/veto-topic'
import { runExportDeliveryForAccount } from './deliver'
import { sweepPublishRecovery } from './recovery'

/**
 * Publishing an article finishes the suggestion it came from.
 *
 * Every article began as a card on the merchant's Opportunities screen — "write
 * something about X". Until this, nothing ever took that card off the screen
 * once the article was out, so finished work sat among things still to do,
 * indefinitely and indistinguishably.
 *
 * The point of testing it here, one level up from the database, is that
 * publishing happens down several routes — the daily hand-over for a store that
 * downloads its articles, the post to a store's own blog, and the recovery
 * sweep adopting a post it finds on the shop after a worker died mid-publish.
 * A completion that only happens on the common route is the same defect with a
 * smaller blast radius, so each route is driven end to end against real
 * Postgres and a fake shop.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-09-03T09:00:00.000Z')
const TODAY = '2026-09-03'

describe.skipIf(!available)('publishing finishes the suggestion behind the article', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string
  let shop: FakeShopifyPublishClient

  const cipher = { decrypt: (value: string) => value.replace(/^enc:/, '') }

  beforeAll(async () => {
    ctx = await setupTestDb('publish_complete_opportunity')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'complete@example.com')
    shop = new FakeShopifyPublishClient()
    await seedStore()
  })

  async function seedStore(): Promise<void> {
    await db.insert(schema.subscriptions).values({
      accountId,
      stripeSubscriptionId: 'sub_test',
      priceId: 'price_test',
      status: 'active',
    })
    await db
      .insert(schema.accountSettings)
      .values({ accountId, timezone: 'UTC', publishHour: 9, delivery: 'export' })
    await db.insert(schema.domains).values({ accountId, domainNormalized: 'acme.com' })
    await db.insert(schema.shopifyConns).values({
      accountId,
      shopHandle: 'acme',
      accessToken: 'enc:token',
      grantedScopes: ['read_products', 'read_content', 'write_content'],
    })
    await setTargetBlog(db, accountScope(accountId), { blogId: 'blog-1', blogHandle: 'news' })
  }

  /** A suggestion that booked a day, whose article is written and cleared to go out. */
  async function seedDay(over: { entityRef?: string; status?: 'scheduled' | 'accepted' } = {}) {
    const [opportunity] = await db
      .insert(schema.opportunities)
      .values({
        accountId,
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: over.entityRef ?? 'best bottles',
        evidenceJson: [],
        impact: 'medium',
        impactScore: 50,
        confidence: 50,
        reasonTemplateKey: 'opportunity.uncovered_commercial_query',
        reasonParamsJson: {},
        recommendedAction: 'create',
        status: over.status ?? 'scheduled',
        preconditionsJson: [],
        limitedIntelligence: false,
        rulesVersion: 'test',
      })
      .returning()
    const [topic] = await db
      .insert(schema.topics)
      .values({
        accountId,
        opportunityId: opportunity!.id,
        title: 'Best bottles',
        targetKeyword: over.entityRef ?? 'best bottles',
        intentClass: 'buying_guide',
        kind: 'new',
        source: 'auto',
        scheduledDate: TODAY,
        state: 'generating',
      })
      .returning()
    await db
      .insert(schema.gateDecisions)
      .values({ accountId, topicId: topic!.id, gate: 3, outcome: 'passed', scoresJson: {} })
    const [article] = await db
      .insert(schema.articles)
      .values({
        accountId,
        topicId: topic!.id,
        title: 'Best bottles',
        slug: over.entityRef ? over.entityRef.replace(/\s+/g, '-') : 'best-bottles',
        targetKeyword: over.entityRef ?? 'best bottles',
        state: 'draft',
        metaDescription: 'How to choose a bottle.',
        bodyJson: { intro: 'Buy a bottle.', sections: [], faq: [] },
      })
      .returning()
    return { opportunityId: opportunity!.id, topicId: topic!.id, articleId: article!.id }
  }

  function deps(over: { now?: () => Date; shopify?: FakeShopifyPublishClient } = {}) {
    return {
      db,
      pool: ctx.pool,
      shopify: over.shopify ?? shop,
      cipher,
      logger: silentLogger,
      now: over.now ?? (() => NOW),
    }
  }

  async function statusOf(opportunityId: string): Promise<string | undefined> {
    const [row] = await db
      .select()
      .from(schema.opportunities)
      .where(eq(schema.opportunities.id, opportunityId))
    return row?.status
  }

  it('takes the card off the Opportunities screen when the article is handed over', async () => {
    const { opportunityId, articleId } = await seedDay()

    const result = await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })

    expect(result).toEqual({ status: 'delivered', articleId, delivery: 'export' })
    expect(await statusOf(opportunityId)).toBe('completed')

    // The screen reads the open set and nothing else, so the finished work is
    // gone from it without the screen knowing anything about publishing.
    const open = await listOpenOpportunities(db, accountScope(accountId))
    expect(open.map((row) => row.id)).not.toContain(opportunityId)
  })

  it('stamps the moment the work landed, which is what the 28-day look-back counts from', async () => {
    const { opportunityId } = await seedDay()

    await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })

    const [row] = await db
      .select()
      .from(schema.opportunities)
      .where(eq(schema.opportunities.id, opportunityId))
    expect(row?.appliedAt).toEqual(NOW)
  })

  it('finishes it when the article goes to the merchant`s own blog instead', async () => {
    await setDeliveryMode(db, accountScope(accountId), 'auto')
    const { opportunityId } = await seedDay()

    const result = await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })

    expect(result).toMatchObject({ status: 'delivered', delivery: 'auto' })
    expect(shop.articles.size).toBe(1)
    expect(await statusOf(opportunityId)).toBe('completed')
  })

  /**
   * The route nobody would find by reading the happy path: the worker is killed
   * between the shop taking the post and us writing it down, and the sweep
   * finds the post already there. That article is published without ever going
   * through the publish hour again.
   */
  it('finishes it when the recovery sweep adopts a post it finds on the shop', async () => {
    await setDeliveryMode(db, accountScope(accountId), 'auto')
    const { opportunityId, articleId } = await seedDay()

    await expect(
      publishArticleToShopify(
        {
          ...deps(),
          checkpoint: (label: string) => {
            if (label === 'publish:executed') throw new Error('worker killed')
          },
        },
        { accountId, articleId },
      ),
    ).rejects.toThrow('worker killed')

    expect(await statusOf(opportunityId)).toBe('scheduled')

    const later = new Date(Date.now() + RECOVERY_GRACE_MS + 1000)
    const summary = await sweepPublishRecovery(deps({ now: () => later }))

    expect(summary).toMatchObject({ adopted: 1 })
    expect(shop.countByMarker(publishMarker(articleId))).toBe(1)
    expect(await statusOf(opportunityId)).toBe('completed')
  })

  it('finishes only the suggestion this article came from', async () => {
    const first = await seedDay()
    const second = await seedDay({ entityRef: 'best flasks' })

    await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })

    // One article a day: whichever went out is finished and the other is
    // untouched, still waiting its turn.
    const statuses = [await statusOf(first.opportunityId), await statusOf(second.opportunityId)]
    expect(statuses.filter((s) => s === 'completed')).toHaveLength(1)
    expect(statuses.filter((s) => s === 'scheduled')).toHaveLength(1)
  })

  it('leaves another store`s suggestion alone', async () => {
    const otherAccountId = await insertAccount(ctx.pool, 'other@example.com')
    const { opportunityId, articleId } = await seedDay()

    const delivered = await markArticleDelivered(
      db,
      accountScope(otherAccountId),
      articleId,
      'export',
      NOW,
    )

    expect(delivered).toBeUndefined()
    expect(await statusOf(opportunityId)).toBe('scheduled')
  })

  /**
   * The suggestion moved on while the article was in the writing pipeline. The
   * completion is a guarded update, so it matches nothing and stops; what it
   * must never do is drag a row the merchant already answered back into a state
   * they did not choose, or take the publication down with it.
   */
  it('stops rather than overwriting a suggestion that had already moved on', async () => {
    const { opportunityId, articleId } = await seedDay()
    await dismissOpportunityGuarded(db, accountScope(accountId), opportunityId, NOW)

    const delivered = await markArticleDelivered(
      db,
      accountScope(accountId),
      articleId,
      'export',
      NOW,
    )

    expect(delivered?.article.state).toBe('published')
    expect(delivered?.completedOpportunity).toBeUndefined()
    expect(await statusOf(opportunityId)).toBe('dismissed')
  })

  /**
   * The race the card names: a merchant pressing "not interested" at the moment
   * the publish hour hands the article over. Both are guarded, both are one
   * transaction, so exactly one of them moves anything.
   */
  it('settles a publication racing a dismissal one way or the other, never half of each', async () => {
    const { opportunityId, articleId } = await seedDay()

    const [dismissal, delivered] = await Promise.all([
      dismissOpportunity({ db, now: () => NOW }, { accountId, opportunityId }),
      markArticleDelivered(db, accountScope(accountId), articleId, 'export', NOW),
    ])

    const status = await statusOf(opportunityId)
    const [article] = await db
      .select()
      .from(schema.articles)
      .where(eq(schema.articles.id, articleId))

    // Exactly one of them moved anything: never both, never neither.
    expect(dismissal.ok).not.toBe(delivered !== undefined)

    if (dismissal.ok) {
      // The merchant got there first. The article was discarded rather than
      // handed over, so there was nothing left to finish.
      expect(status).toBe('dismissed')
      expect(article?.state).toBe('discarded')
    } else {
      // The publication got there first, and finished the suggestion on its
      // way out; the whole dismissal rolled back.
      expect(status).toBe('completed')
      expect(delivered?.completedOpportunity?.id).toBe(opportunityId)
      expect(article?.state).toBe('published')
    }
  })
})
