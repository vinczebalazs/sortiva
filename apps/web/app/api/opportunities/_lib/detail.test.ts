import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { opportunityDetailResponseSchema, serpSnapshotKey } from '@sortiva/core'
import { databaseAvailable, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { rules } from '@sortiva/rules'
import { withAccount } from '../../auth/_lib/session'
import { makeOpportunityDetailHandler } from './handlers'

/**
 * The opportunity drawer's own read, driven end to end: the real session
 * wrapper, the real handler, the real repositories, a real Postgres.
 *
 * This endpoint was declared in the frozen route table, called by a finished
 * screen, and built nowhere — and because the screen swallows any failure into
 * "no data", the drawer simply never opened with anything in it. Mocking the
 * fetch here would reproduce that; these tests prove the route module is on
 * disk at the address the screen calls, and prove the handler reads a real
 * stored record back.
 */

describe('the route exists where the screen calls it', () => {
  it('serves GET /api/opportunities/{id}', async () => {
    const route = await import('../[id]/route')
    expect(typeof route.GET).toBe('function')
    expect(route.dynamic).toBe('force-dynamic')
  })
})

const available = await databaseAvailable()

const NOW = new Date('2026-09-07T00:00:00Z')

describe.skipIf(!available)('reading one opportunity', () => {
  let harness: TestDb
  let mine: string
  let theirs: string
  let optimizeId: string
  let holdId: string

  beforeAll(async () => {
    harness = await setupTestDb('web_opportunity_detail')
  })

  afterAll(async () => {
    await harness.close()
  })

  const insertOpportunity = async (
    accountId: string,
    row: {
      signalType: string
      entityType: string
      entityRef: string
      action: string
      status: string
      reasonKey: string
      reasonParams?: string
      evidence?: string
      preconditions?: string
    },
  ) => {
    const { rows } = await harness.pool.query<{ id: string }>(
      `INSERT INTO opportunities
         (account_id, signal_type, entity_type, entity_ref, evidence_json, impact, impact_score,
          confidence, reason_template_key, reason_params_json, recommended_action,
          preconditions_json, status, rules_version)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'high', 80, 72, $6, $7::jsonb, $8, $9::jsonb, $10, 'test-rules')
       RETURNING id`,
      [
        accountId,
        row.signalType,
        row.entityType,
        row.entityRef,
        row.evidence ?? '[]',
        row.reasonKey,
        row.reasonParams ?? '{}',
        row.action,
        row.preconditions ?? '[]',
        row.status,
      ],
    )
    return rows[0]!.id
  }

  beforeEach(async () => {
    await truncateAll(harness.pool)
    const { rows } = await harness.pool.query<{ id: string; email: string }>(
      "INSERT INTO accounts (email) VALUES ('mine@example.com'), ('theirs@example.com') RETURNING id, email",
    )
    mine = rows.find((row) => row.email === 'mine@example.com')!.id
    theirs = rows.find((row) => row.email === 'theirs@example.com')!.id

    optimizeId = await insertOpportunity(mine, {
      signalType: 'striking_distance',
      entityType: 'url',
      entityRef: 'https://example.com/collections/trail',
      action: 'optimize',
      status: 'new',
      reasonKey: 'striking_distance.page_one_reachable',
      reasonParams: JSON.stringify({ position: 8.6 }),
      evidence: JSON.stringify([
        {
          key: 'impressions_28d',
          value: 8400,
          source: 'gsc',
          window: '28d',
          fetchedAt: '2026-09-05T00:00:00Z',
        },
      ]),
    })

    holdId = await insertOpportunity(mine, {
      signalType: 'catalog_richness_gap',
      entityType: 'query_cluster',
      entityRef: 'wide trail shoes',
      action: 'hold',
      status: 'blocked',
      reasonKey: 'catalog_richness_gap.insufficient_substance',
      preconditions: JSON.stringify(['catalog_richness_gap']),
    })

    await harness.pool.query(
      `INSERT INTO opportunity_tasks (opportunity_id, kind, description)
       VALUES ($1, 'add_section', 'Add a buying-criteria section to the collection')`,
      [optimizeId],
    )
  })

  const detail = (accountId: string | null, id: string) =>
    withAccount(
      makeOpportunityDetailHandler({ db: harness.db, now: () => NOW }),
      async () => accountId,
    )(new Request(`http://localhost/api/opportunities/${id}`), {
      params: Promise.resolve({ id }),
    })

  it('answers with the stored record behind the card', async () => {
    const response = await detail(mine, optimizeId)
    expect(response.status).toBe(200)
    const body = opportunityDetailResponseSchema.parse(await response.json())

    expect(body.opportunity.id).toBe(optimizeId)
    expect(body.opportunity.recommendedAction).toBe('OPTIMIZE')
    expect(body.opportunity.entityRef.kind).toBe('page')
    expect(body.opportunity.evidence[0]!.value).toBe(8400)
    expect(body.tasks).toEqual([
      {
        id: expect.any(String),
        label: 'Add a buying-criteria section to the collection',
        state: 'open',
      },
    ])
  })

  it('sends every sentence as a key and its parameters, never as prose', async () => {
    const body = opportunityDetailResponseSchema.parse(
      await (await detail(mine, optimizeId)).json(),
    )
    expect(body.opportunity.why).toEqual({
      templateKey: 'striking_distance.page_one_reachable',
      params: { position: 8.6 },
    })

    const hold = opportunityDetailResponseSchema.parse(await (await detail(mine, holdId)).json())
    expect(hold.opportunity.preconditions).toEqual([
      { code: 'catalog_richness_gap', whatToDo: { templateKey: 'precondition.catalog_richness_gap', params: {} } },
    ])
  })

  it('says nothing about whether it worked until something has measured it', async () => {
    const body = opportunityDetailResponseSchema.parse(
      await (await detail(mine, optimizeId)).json(),
    )
    expect(body.outcome).toBeNull()
  })

  it('reads back an outcome once one has been recorded', async () => {
    await harness.pool.query(
      `UPDATE opportunities
          SET outcome_json = '{"label":"improved","before":8.6,"after":4.1}'::jsonb,
              outcome_measured_at = '2026-09-06T00:00:00Z'
        WHERE id = $1`,
      [optimizeId],
    )
    const body = opportunityDetailResponseSchema.parse(
      await (await detail(mine, optimizeId)).json(),
    )
    expect(body.outcome).toEqual({
      label: 'improved',
      measuredAt: '2026-09-06T00:00:00.000Z',
      before: 8.6,
      after: 4.1,
    })
  })

  it('records the moments it actually has a date for, and no others', async () => {
    const before = opportunityDetailResponseSchema.parse(
      await (await detail(mine, optimizeId)).json(),
    )
    expect(before.history.map((entry) => entry.to)).toEqual(['new'])

    await harness.pool.query(
      "UPDATE opportunities SET applied_at = '2026-09-05T10:00:00Z' WHERE id = $1",
      [optimizeId],
    )
    const after = opportunityDetailResponseSchema.parse(
      await (await detail(mine, optimizeId)).json(),
    )
    expect(after.history.map((entry) => entry.to)).toEqual(['new', 'completed'])
    expect(after.history[1]!.actor).toBe('user')
  })

  it('offers the recommendation view only where there is one to offer', async () => {
    const optimize = opportunityDetailResponseSchema.parse(
      await (await detail(mine, optimizeId)).json(),
    )
    expect(optimize.recommendation?.state).toBe('none')

    const hold = opportunityDetailResponseSchema.parse(await (await detail(mine, holdId)).json())
    expect(hold.recommendation).toBeNull()
  })

  it('shows a generated recommendation, and shows a failed one as one sentence with no draft in it', async () => {
    await harness.pool.query(
      `INSERT INTO optimize_recommendations
         (opportunity_id, page_url, recommendation_json, prompt_version, model_id, rules_version, state)
       VALUES ($1, 'https://example.com/collections/trail', $2::jsonb, 'optimize.v1', 'test-model', 'test-rules', 'valid')`,
      [
        optimizeId,
        JSON.stringify({
          title_tag: { current: 'Trail shoes', suggested: 'Wide-fit trail running shoes', rationale: '3 of top 5 cover width' },
          meta_description: { current: null, suggested: 'Find trail shoes that fit wider feet.', rationale: null },
          headings: [],
          sections: [],
          faq: [],
          internal_links: {
            add_from: [{ url: '/blogs/journal/sizing', anchor: 'wide fit' }],
            add_to: [{ url: '/products/trailhead-4-wide', anchor: 'Trailhead 4 Wide' }],
          },
          intent_note: 'The query is a buying decision, not a definition.',
        }),
      ],
    )

    const ready = opportunityDetailResponseSchema.parse(
      await (await detail(mine, optimizeId)).json(),
    )
    expect(ready.recommendation?.state).toBe('ready')
    expect(ready.recommendation?.fields.map((field) => field.field)).toEqual([
      'title_tag',
      'meta_description',
    ])
    expect(ready.recommendation?.internalLinksIn).toEqual([
      { fromUrl: '/blogs/journal/sizing', anchor: 'wide fit' },
    ])

    await harness.pool.query(
      "UPDATE optimize_recommendations SET state = 'failed_validation' WHERE opportunity_id = $1",
      [optimizeId],
    )
    const failed = opportunityDetailResponseSchema.parse(
      await (await detail(mine, optimizeId)).json(),
    )
    expect(failed.recommendation?.state).toBe('failed_validation')
    // No half-finished draft anybody could paste into their shop.
    expect(failed.recommendation?.fields).toEqual([])
    expect(failed.recommendation?.failureReason).toEqual({
      templateKey: 'optimize.failedValidation.reason',
      params: {},
    })
  })

  it('shows who else Google ranks, from the results page we already bought', async () => {
    await harness.pool.query(
      `INSERT INTO personas (account_id, description, language, country, prompt_version, model_id)
       VALUES ($1, 'A trail running shop.', 'en', 'GB', 'persona.v1', 'test-model')`,
      [mine],
    )
    const key = serpSnapshotKey({
      query: 'wide trail shoes',
      locale: { language: 'en', country: 'GB' },
      depth: rules().defaults.discovery.competitors.serp_position_max,
    })
    await harness.pool.query(
      `INSERT INTO serp_snapshots (cache_key, query, locale, results_json, expires_at)
       VALUES ($1, 'wide trail shoes', 'en-GB', $2::jsonb, '2026-09-30T00:00:00Z')`,
      [
        key,
        JSON.stringify([
          { position: 1, url: 'https://rival.example/wide', domain: 'rival.example', title: 'Wide trail shoes' },
        ]),
      ],
    )

    const body = opportunityDetailResponseSchema.parse(await (await detail(mine, holdId)).json())
    expect(body.serpSnapshot).toEqual([
      { position: 1, domain: 'rival.example', url: 'https://rival.example/wide' },
    ])
  })

  it('refuses a results page that has gone stale rather than showing an old one', async () => {
    await harness.pool.query(
      `INSERT INTO personas (account_id, description, language, country, prompt_version, model_id)
       VALUES ($1, 'A trail running shop.', 'en', 'GB', 'persona.v1', 'test-model')`,
      [mine],
    )
    const key = serpSnapshotKey({
      query: 'wide trail shoes',
      locale: { language: 'en', country: 'GB' },
      depth: rules().defaults.discovery.competitors.serp_position_max,
    })
    await harness.pool.query(
      `INSERT INTO serp_snapshots (cache_key, query, locale, results_json, expires_at)
       VALUES ($1, 'wide trail shoes', 'en-GB', '[]'::jsonb, '2026-09-01T00:00:00Z')`,
      [key],
    )

    const body = opportunityDetailResponseSchema.parse(await (await detail(mine, holdId)).json())
    expect(body.serpSnapshot).toBeNull()
  })

  it('is gone for an id that is not this account’s', async () => {
    const otherId = await insertOpportunity(theirs, {
      signalType: 'striking_distance',
      entityType: 'url',
      entityRef: 'https://elsewhere.example/secret',
      action: 'optimize',
      status: 'new',
      reasonKey: 'striking_distance.page_one_reachable',
    })

    const response = await detail(mine, otherId)
    expect(response.status).toBe(404)
    expect(JSON.stringify(await response.json())).not.toContain('elsewhere.example')
  })
})
