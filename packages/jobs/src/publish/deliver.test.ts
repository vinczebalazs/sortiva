import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { ACCOUNT_PUBLISHING_PAUSED_FLAG, silentLogger } from '@sortiva/core'
import { accountScope, schema, tripAccountFlag, type Db } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { runExportDeliveryForAccount } from './deliver'

/**
 * The publish hour, against a real Postgres.
 *
 * The thing being proved is a negative as much as a positive: an article that
 * passed the quality gate is **not** published when it passed. It sits until
 * the store's own publish hour, and only then does it become something the
 * merchant has.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-09-03T09:00:00.000Z')
const TODAY = '2026-09-03'

describe.skipIf(!available)('handing over an article at the publish hour', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('publish_delivery')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'delivery@example.com')
    await seedStore()
  })

  async function seedStore(over: { delivery?: 'export' | 'auto'; vacationMode?: boolean } = {}) {
    await db.insert(schema.subscriptions).values({
      accountId,
      stripeSubscriptionId: 'sub_test',
      priceId: 'price_test',
      status: 'active',
    })
    await db.insert(schema.accountSettings).values({
      accountId,
      timezone: 'UTC',
      publishHour: 9,
      delivery: over.delivery ?? 'export',
      vacationMode: over.vacationMode ?? false,
    })
  }

  /** A topic, plus an article on it, in whatever state the case needs. */
  async function seedArticle(options: {
    readonly title: string
    readonly gateOutcome?: 'passed' | 'rejected'
    readonly state?: 'draft' | 'in_review' | 'cleared_to_deliver'
    readonly override?: boolean
    readonly createdAt?: Date
  }): Promise<string> {
    const [opportunity] = await db
      .insert(schema.opportunities)
      .values({
        accountId,
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: options.title,
        evidenceJson: [],
        impact: 'medium',
        impactScore: 50,
        confidence: 50,
        reasonTemplateKey: 'opportunity.uncovered_commercial_query',
        reasonParamsJson: {},
        recommendedAction: 'create',
        status: 'scheduled',
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
        title: options.title,
        targetKeyword: options.title.toLowerCase(),
        intentClass: 'buying_guide',
        kind: 'new',
        source: 'auto',
        scheduledDate: TODAY,
        state: 'generating',
      })
      .returning()
    if (options.gateOutcome) {
      await db.insert(schema.gateDecisions).values({
        accountId,
        topicId: topic!.id,
        gate: 3,
        outcome: options.gateOutcome,
        scoresJson: {},
      })
    }
    const [article] = await db
      .insert(schema.articles)
      .values({
        accountId,
        topicId: topic!.id,
        title: options.title,
        slug: options.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        targetKeyword: options.title.toLowerCase(),
        state: options.state ?? 'draft',
        publishedViaOverride: options.override ?? false,
        bodyJson: { intro: 'Hello.', sections: [], faq: [] },
        ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      })
      .returning()
    return article!.id
  }

  function deps() {
    return { db, pool: ctx.pool, now: () => NOW, logger: silentLogger }
  }

  async function articleStates(): Promise<Record<string, { state: string; publishedAt: Date | null }>> {
    const rows = await db
      .select({
        title: schema.articles.title,
        state: schema.articles.state,
        publishedAt: schema.articles.publishedAt,
      })
      .from(schema.articles)
      .where(eq(schema.articles.accountId, accountId))
    return Object.fromEntries(rows.map((r) => [r.title, { state: r.state, publishedAt: r.publishedAt }]))
  }

  /**
   * The card's own done-when: the article appears at the hour, not at the
   * moment the quality gate passed it. Passing the gate leaves it a draft;
   * this run is what publishes it.
   */
  it('publishes a passed article at the hour and not before', async () => {
    await seedArticle({ title: 'Best bottles', gateOutcome: 'passed' })

    // Gate 3 has passed and nothing has run since: still a draft.
    expect((await articleStates())['Best bottles']!.state).toBe('draft')

    const result = await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })

    expect(result.status).toBe('delivered')
    const after = (await articleStates())['Best bottles']!
    expect(after.state).toBe('published')
    expect(after.publishedAt).toEqual(NOW)
  })

  it('marks it export-delivered, and writes nothing anywhere else', async () => {
    await seedArticle({ title: 'Best bottles', gateOutcome: 'passed' })
    await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })

    const [row] = await db.select().from(schema.articles).where(eq(schema.articles.accountId, accountId))
    expect(row!.delivery).toBe('export')
    // Nothing was posted anywhere: an export delivery creates no publish intent.
    const intents = await db
      .select()
      .from(schema.publishIntents)
      .where(eq(schema.publishIntents.accountId, accountId))
    expect(intents).toEqual([])
    // And no address is invented on the merchant's behalf.
    expect(row!.publishedUrl).toBeNull()
  })

  it('hands over one article per pass, oldest first', async () => {
    await seedArticle({
      title: 'Older',
      gateOutcome: 'passed',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    })
    await seedArticle({
      title: 'Newer',
      gateOutcome: 'passed',
      createdAt: new Date('2026-09-02T00:00:00.000Z'),
    })

    await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })

    const states = await articleStates()
    expect(states['Older']!.state).toBe('published')
    expect(states['Newer']!.state).toBe('draft')
  })

  it('does the day once, however many times the job is delivered', async () => {
    await seedArticle({ title: 'Older', gateOutcome: 'passed', createdAt: new Date('2026-09-01T00:00:00.000Z') })
    await seedArticle({ title: 'Newer', gateOutcome: 'passed', createdAt: new Date('2026-09-02T00:00:00.000Z') })

    const first = await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })
    const second = await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })

    expect(first.status).toBe('delivered')
    expect(second.status).toBe('already_done')
    const states = await articleStates()
    expect(states['Newer']!.state).toBe('draft')
  })

  /**
   * The only decision recorded against this topic is the refusal, and it still
   * goes out — because the article's own state says a person cleared it.
   */
  it('publishes an article the merchant overruled the gate on, with no passing decision anywhere', async () => {
    await seedArticle({
      title: 'Overridden',
      gateOutcome: 'rejected',
      state: 'cleared_to_deliver',
      override: true,
    })
    const result = await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })
    expect(result.status).toBe('delivered')
    expect((await articleStates())['Overridden']!.state).toBe('published')
  })

  it('never publishes a draft nothing has graded', async () => {
    await seedArticle({ title: 'Ungraded' })
    const result = await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })
    expect(result).toEqual({ status: 'skipped', reason: 'nothing_ready' })
    expect((await articleStates())['Ungraded']!.state).toBe('draft')
  })

  /**
   * The reason the state exists, stated as the thing that must not happen: an
   * un-graded draft sitting alongside an overruled article on the same store
   * still goes nowhere, and the overruled one is what the day hands over.
   */
  it('hands over the overruled article and leaves the un-graded draft where it is', async () => {
    await seedArticle({ title: 'Ungraded', createdAt: new Date('2026-09-01T00:00:00.000Z') })
    await seedArticle({
      title: 'Overridden',
      gateOutcome: 'rejected',
      state: 'cleared_to_deliver',
      override: true,
      createdAt: new Date('2026-09-02T00:00:00.000Z'),
    })

    const result = await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })

    expect(result.status).toBe('delivered')
    const states = await articleStates()
    expect(states['Overridden']!.state).toBe('published')
    expect(states['Ungraded']!.state).toBe('draft')
    expect(states['Ungraded']!.publishedAt).toBeNull()
  })

  it('leaves a draft that is still waiting for the merchant alone', async () => {
    await seedArticle({ title: 'Waiting', gateOutcome: 'passed', state: 'in_review' })
    const result = await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })
    expect(result).toEqual({ status: 'skipped', reason: 'nothing_ready' })
  })

  it('stops while the merchant is away', async () => {
    await db
      .update(schema.accountSettings)
      .set({ vacationMode: true })
      .where(eq(schema.accountSettings.accountId, accountId))
    await seedArticle({ title: 'Best bottles', gateOutcome: 'passed' })

    const result = await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })
    expect(result).toEqual({ status: 'skipped', reason: 'vacation' })
  })

  it('stops when the payment failed, and the article stays readable', async () => {
    await db
      .update(schema.subscriptions)
      .set({ status: 'past_due' })
      .where(eq(schema.subscriptions.accountId, accountId))
    await seedArticle({ title: 'Best bottles', gateOutcome: 'passed' })

    const result = await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })
    expect(result).toEqual({ status: 'skipped', reason: 'not_entitled' })
    expect((await articleStates())['Best bottles']!.state).toBe('draft')
  })

  it('stops on the publishing kill switch without stopping anything else', async () => {
    await tripAccountFlag(db, accountScope(accountId), {
      flag: ACCOUNT_PUBLISHING_PAUSED_FLAG,
      actor: 'spend_cap_sweep',
      reason: 'publishing failures over the trip threshold',
      trippedBy: 'auto',
    })
    await seedArticle({ title: 'Best bottles', gateOutcome: 'passed' })

    const result = await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })
    // The switch that was raised is named in the log line, not in the outcome —
    // the same shape the generation cycle uses.
    expect(result).toEqual({ status: 'skipped', reason: 'paused' })
    expect((await articleStates())['Best bottles']!.state).toBe('draft')
  })

  /**
   * A process with no way to write to a shop cannot serve an auto-publish
   * store. Exporting instead would be delivering in a mode the merchant did not
   * choose, and marking the article published with no address would make it
   * look posted when nothing was — so it waits.
   */
  it('never exports an article for a store that asked for publishing', async () => {
    await db
      .update(schema.accountSettings)
      .set({ delivery: 'auto' })
      .where(eq(schema.accountSettings.accountId, accountId))
    await seedArticle({ title: 'Best bottles', gateOutcome: 'passed' })

    const result = await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })
    expect(result).toEqual({ status: 'skipped', reason: 'auto_publish_unconfigured' })
    expect((await articleStates())['Best bottles']!.state).toBe('draft')
  })

  it('does not reach into another account\'s finished work', async () => {
    const other = await insertAccount(ctx.pool, 'other@example.com')
    await seedArticle({ title: 'Best bottles', gateOutcome: 'passed' })

    const result = await runExportDeliveryForAccount(deps(), { accountId: other, date: TODAY })
    expect(result.status).toBe('skipped')
    expect((await articleStates())['Best bottles']!.state).toBe('draft')
  })
})
