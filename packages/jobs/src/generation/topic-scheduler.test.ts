import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fixtureCreateOpportunity, fixtureOpportunity, type Opportunity } from '@sortiva/core'
import { accountScope, findTopic, insertTopic, insertMinimalOpportunity, type Db } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { DbTopicScheduler, TopicSchedulingError } from './topic-scheduler'

const available = await databaseAvailable()
const NOW = new Date('2026-03-10T08:00:00.000Z')

describe.skipIf(!available)('DbTopicScheduler against real data', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('generation_topic_scheduler')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'topic-scheduler@example.com')
  })

  /** A real `opportunities` row (the FK `topics.opportunity_id` demands) shaped as the contract type the scheduler reads. */
  async function createOpportunity(overrides: Partial<Opportunity> = {}, entityRef?: string): Promise<Opportunity> {
    const scope = accountScope(accountId)
    const row = await insertMinimalOpportunity(
      db,
      scope,
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: entityRef ?? `q-${Math.random()}`,
        evidenceJson: [],
        recommendedAction: 'create',
        status: 'accepted',
        reasonTemplateKey: fixtureCreateOpportunity.reasonTemplateKey,
        reasonParams: fixtureCreateOpportunity.reasonParams,
        limitedIntelligence: false,
        rulesVersion: fixtureCreateOpportunity.rulesVersion,
      },
      NOW,
    )
    return {
      ...fixtureCreateOpportunity,
      id: row.id,
      accountId,
      evidence: [
        ...fixtureCreateOpportunity.evidence,
        { key: 'intent_class', value: 'buying_guide', source: 'catalog', fetchedAt: NOW.toISOString() },
      ],
      ...overrides,
    }
  }

  it('places a CREATE opportunity on the next open day', async () => {
    const scheduler = new DbTopicScheduler({ db, now: () => NOW })
    const opportunity = await createOpportunity()
    const scheduled = await scheduler.schedule(opportunity)

    expect(scheduled.scheduledFor).toBe('2026-03-11')
    expect(scheduled.state).toBe('planned')
    expect(scheduled.title).toBe(opportunity.entityRef.label)
  })

  it('never displaces a pinned occupant, and lands on the next open day instead', async () => {
    const scope = accountScope(accountId)
    const opportunity = await insertMinimalOpportunity(
      db,
      scope,
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: 'q-pinned',
        evidenceJson: [],
        recommendedAction: 'create',
        status: 'scheduled',
        reasonTemplateKey: 'gate1.admitted',
        reasonParams: {},
        limitedIntelligence: false,
        rulesVersion: 'a'.repeat(64),
      },
      NOW,
    )
    await insertTopic(
      db,
      scope,
      {
        opportunityId: opportunity.id,
        title: 'Already pinned',
        targetKeyword: 'already pinned',
        keywordCluster: null,
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'manual',
        whyLine: 'topic.manual_addition',
        scheduledDate: '2026-03-11',
        pinned: true,
        state: 'planned',
      },
      NOW,
    )

    const scheduler = new DbTopicScheduler({ db, now: () => NOW })
    const scheduled = await scheduler.schedule(await createOpportunity())

    expect(scheduled.scheduledFor).toBe('2026-03-12')
  })

  it('honours a requested date when it is open', async () => {
    const scheduler = new DbTopicScheduler({ db, now: () => NOW })
    const scheduled = await scheduler.schedule(await createOpportunity(), '2026-04-01')
    expect(scheduled.scheduledFor).toBe('2026-04-01')
  })

  it('refuses to place a HOLD opportunity', async () => {
    const scheduler = new DbTopicScheduler({ db, now: () => NOW })
    await expect(scheduler.schedule({ ...fixtureOpportunity, recommendedAction: 'HOLD' })).rejects.toThrow(
      TopicSchedulingError,
    )
  })

  it('refuses to guess an intent class when the opportunity carries none', async () => {
    const scheduler = new DbTopicScheduler({ db, now: () => NOW })
    await expect(scheduler.schedule({ ...fixtureCreateOpportunity, accountId })).rejects.toThrow(
      TopicSchedulingError,
    )
  })

  /**
   * Without this the topic reaches the pipeline with nothing to write about
   * and is held as a thin evidence pack — every automatically scheduled topic,
   * every time. The families are carried as one repeated `family_id` fact,
   * because a fact's value cannot be an array; the detectors already emit them
   * that way.
   */
  it('carries the families the opportunity is backed by onto the topic', async () => {
    const familyA = '44444444-4444-4444-8444-444444444444'
    const familyB = '55555555-5555-4555-8555-555555555555'
    const opportunity = await createOpportunity()
    const scheduler = new DbTopicScheduler({ db, now: () => NOW })
    const scheduled = await scheduler.schedule({
      ...opportunity,
      evidence: [
        ...opportunity.evidence,
        { key: 'family_id', value: familyA, source: 'content_inventory', fetchedAt: NOW.toISOString() },
        { key: 'family_id', value: familyB, source: 'content_inventory', fetchedAt: NOW.toISOString() },
        // A repeat and a malformed one: neither may reach the uuid column.
        { key: 'family_id', value: familyA, source: 'content_inventory', fetchedAt: NOW.toISOString() },
        { key: 'family_id', value: 'not-a-uuid', source: 'content_inventory', fetchedAt: NOW.toISOString() },
      ],
    })

    const topic = await findTopic(db, accountScope(accountId), scheduled.topicId)
    expect(topic?.familyIds).toEqual([familyA, familyB])
  })

  it('still places an opportunity that names no family, leaving the pipeline to say so', async () => {
    const scheduler = new DbTopicScheduler({ db, now: () => NOW })
    const scheduled = await scheduler.schedule(await createOpportunity())
    const topic = await findTopic(db, accountScope(accountId), scheduled.topicId)
    expect(topic?.familyIds).toEqual([])
  })
})
