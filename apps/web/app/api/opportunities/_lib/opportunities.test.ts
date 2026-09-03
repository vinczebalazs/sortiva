import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { listOpportunitiesResponseSchema } from '@sortiva/core'
import { accountScope, insertMinimalOpportunity, type MinimalOpportunityInput } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { withAccount } from '../../auth/_lib/session'
import {
  makeDismissOpportunityHandler,
  makeListOpportunitiesHandler,
  makeScheduleOpportunityHandler,
  makeUndismissOpportunityHandler,
} from './handlers'

const available = await databaseAvailable()
const NOW = new Date('2026-09-07T08:00:00.000Z')

describe.skipIf(!available)('/api/opportunities — the route against real rows, validated against the frozen schema', () => {
  let harness: TestDb
  let accountId: string

  beforeAll(async () => {
    harness = await setupTestDb('web_opportunities')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    accountId = await insertAccount(harness.pool, 'opportunities-route@example.com')
  })

  async function seedOpportunity(overrides: Partial<MinimalOpportunityInput> = {}) {
    return insertMinimalOpportunity(
      harness.db,
      accountScope(accountId),
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: 'best trail running shoes',
        evidenceJson: [{ key: 'keyword', value: 'best trail running shoes', source: 'content_inventory', fetchedAt: NOW.toISOString() }],
        recommendedAction: 'create',
        status: 'accepted',
        reasonTemplateKey: 'uncovered_commercial_query.create',
        reasonParams: { keyword: 'best trail running shoes' },
        limitedIntelligence: false,
        rulesVersion: 'a'.repeat(64),
        ...overrides,
      },
      NOW,
    )
  }

  const listRoute = () => withAccount(makeListOpportunitiesHandler({ db: harness.db }), async () => accountId)
  const dismissRoute = (id: string) =>
    withAccount(makeDismissOpportunityHandler({ db: harness.db }), async () => accountId)(
      new Request(`http://localhost/api/opportunities/${id}/dismiss`, { method: 'POST' }),
      { params: Promise.resolve({ id }) },
    )
  const undismissRoute = (id: string) =>
    withAccount(makeUndismissOpportunityHandler({ db: harness.db }), async () => accountId)(
      new Request(`http://localhost/api/opportunities/${id}/undismiss`, { method: 'POST' }),
      { params: Promise.resolve({ id }) },
    )
  const scheduleRoute = (id: string) =>
    withAccount(makeScheduleOpportunityHandler({ db: harness.db }), async () => accountId)(
      new Request(`http://localhost/api/opportunities/${id}/schedule`, { method: 'POST' }),
      { params: Promise.resolve({ id }) },
    )

  it('an empty store validates against the frozen schema — the exhaustive byAction record included', async () => {
    const response = await listRoute()(new Request('http://localhost/api/opportunities'), undefined)
    expect(response.status).toBe(200)
    const body = listOpportunitiesResponseSchema.parse(await response.json())
    expect(body.opportunities).toHaveLength(0)
    expect(body.counts).toEqual({ open: 0, byAction: { CREATE: 0, OPTIMIZE: 0, REFRESH: 0, FIX: 0, HOLD: 0 } })
  })

  it('a real open opportunity round-trips through the list and validates in full, evidence and preconditions included', async () => {
    await seedOpportunity()
    const response = await listRoute()(new Request('http://localhost/api/opportunities'), undefined)
    const body = listOpportunitiesResponseSchema.parse(await response.json())

    expect(body.opportunities).toHaveLength(1)
    expect(body.counts.byAction.CREATE).toBe(1)
    const row = body.opportunities[0]!
    expect(row.recommendedAction).toBe('CREATE')
    expect(row.status).toBe('accepted')
    expect(row.evidence[0]?.key).toBe('keyword')
    expect(row.why.templateKey).toBe('uncovered_commercial_query.create')
  })

  it('a blocked opportunity carries its precondition, with a whatToDo why-line', async () => {
    await seedOpportunity({ status: 'blocked', preconditions: ['catalog_richness_gap'] })
    const response = await listRoute()(new Request('http://localhost/api/opportunities'), undefined)
    const body = listOpportunitiesResponseSchema.parse(await response.json())
    expect(body.opportunities[0]?.preconditions).toEqual([
      { code: 'catalog_richness_gap', whatToDo: { templateKey: 'precondition.catalog_richness_gap', params: {} } },
    ])
  })

  it('dismiss: guards on an open status, 409 once already dismissed, 404 once gone', async () => {
    const opportunity = await seedOpportunity()
    const first = await dismissRoute(opportunity.id)
    expect(first.status).toBe(200)

    const second = await dismissRoute(opportunity.id)
    expect(second.status).toBe(409)
    expect((await second.json()).error.code).toBe('opportunity_not_open')

    const missing = await dismissRoute('00000000-0000-0000-0000-000000000000')
    expect(missing.status).toBe(404)
  })

  it('undismiss: returns a dismissed row to new', async () => {
    const opportunity = await seedOpportunity()
    await dismissRoute(opportunity.id)
    const response = await undismissRoute(opportunity.id)
    expect(response.status).toBe(200)
    expect((await response.json()).status).toBe('new')
  })

  it('schedule: refuses an opportunity that is not an accepted CREATE/REFRESH', async () => {
    const opportunity = await seedOpportunity({ status: 'new' })
    const response = await scheduleRoute(opportunity.id)
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('opportunity_not_open')
  })

  it('schedule: 422s rather than guessing when the opportunity carries no usable intent_class evidence fact', async () => {
    // No `intent_class` fact — the T4.2-flagged gap `DbTopicScheduler`
    // refuses rather than guesses past (main §14.4, degrade to pause).
    const opportunity = await seedOpportunity()
    const response = await scheduleRoute(opportunity.id)
    expect(response.status).toBe(422)
    expect((await response.json()).error.code).toBe('opportunity_not_schedulable')
  })

  it('schedule: places an accepted CREATE and completes the accepted -> scheduled edge', async () => {
    // `DbTopicScheduler` needs the `intent_class` evidence-fact convention
    // (DECISIONS 2026-09-03 T4.2/T3.7) or it refuses rather than guesses —
    // this opportunity carries it, matching what a real detector now stamps.
    const opportunity = await seedOpportunity({
      evidenceJson: [
        { key: 'keyword', value: 'best trail running shoes', source: 'content_inventory', fetchedAt: NOW.toISOString() },
        { key: 'intent_class', value: 'buying_guide', source: 'content_inventory', fetchedAt: NOW.toISOString() },
      ],
    })
    const response = await scheduleRoute(opportunity.id)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.topicId).toBeTruthy()
    expect(body.scheduledFor).toBeTruthy()

    const { findOpportunityById } = await import('@sortiva/db')
    const row = await findOpportunityById(harness.db, accountScope(accountId), opportunity.id)
    expect(row?.status).toBe('scheduled')
  })
})
