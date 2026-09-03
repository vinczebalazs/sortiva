import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { calendarResponseSchema } from '@sortiva/core'
import { accountScope, insertMinimalOpportunity, insertTopic } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { withAccount } from '../../auth/_lib/session'
import { makeGetCalendarHandler } from './handlers'

const available = await databaseAvailable()
const NOW = new Date('2026-03-10T08:00:00.000Z')

describe.skipIf(!available)('GET /api/calendar', () => {
  let harness: TestDb
  let accountId: string

  beforeAll(async () => {
    harness = await setupTestDb('web_calendar_get')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    accountId = await insertAccount(harness.pool, 'calendar-get@example.com')
    // An account with no subscription row reads as not entitled, which is a
    // real "paused" cause (`lifecycleGate`'s billing check) — seeded here so
    // the tests below observe the calendar's own read, not billing's.
    await harness.pool.query(
      'INSERT INTO subscriptions (account_id, stripe_subscription_id, price_id, status) VALUES ($1, $2, $3, $4)',
      [accountId, 'sub_test', 'price_test', 'active'],
    )
  })

  const route = (id: string | null) =>
    withAccount(makeGetCalendarHandler({ db: harness.db }), async () => id)

  const get = (id: string | null, query: string) =>
    route(id)(new Request(`http://localhost/api/calendar${query}`), undefined)

  it('lists topics scheduled in range, matching the response contract', async () => {
    const scope = accountScope(accountId)
    const opportunity = await insertMinimalOpportunity(
      harness.db,
      scope,
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: 'q-1',
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
      harness.db,
      scope,
      {
        opportunityId: opportunity.id,
        title: 'Best trail running shoes',
        targetKeyword: 'best trail running shoes',
        keywordCluster: null,
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'auto',
        whyLine: 'topic.auto',
        scheduledDate: '2026-03-15',
        pinned: false,
        state: 'planned',
      },
      NOW,
    )

    const response = await get(accountId, '?from=2026-03-01&to=2026-03-31')
    expect(response.status).toBe(200)
    const body = calendarResponseSchema.parse(await response.json())

    expect(body.topics).toHaveLength(1)
    expect(body.topics[0]?.title).toBe('Best trail running shoes')
    expect(body.topics[0]?.signalType).toBe('uncovered_commercial_query')
    expect(body.paused.active).toBe(false)
    expect(body.nextReplenishmentAt).toBeNull()
  })

  it('excludes topics outside the requested range', async () => {
    const scope = accountScope(accountId)
    const opportunity = await insertMinimalOpportunity(
      harness.db,
      scope,
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: 'q-2',
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
      harness.db,
      scope,
      {
        opportunityId: opportunity.id,
        title: 'Out of range',
        targetKeyword: null,
        keywordCluster: null,
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'auto',
        whyLine: 'topic.auto',
        scheduledDate: '2026-05-01',
        pinned: false,
        state: 'planned',
      },
      NOW,
    )

    const response = await get(accountId, '?from=2026-03-01&to=2026-03-31')
    const body = calendarResponseSchema.parse(await response.json())
    expect(body.topics).toHaveLength(0)
  })

  it('rejects a malformed query', async () => {
    const response = await get(accountId, '?from=not-a-date&to=2026-03-31')
    expect(response.status).toBe(422)
  })
})
