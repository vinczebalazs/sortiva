import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { calendarResponseSchema } from '@sortiva/core'
import {
  accountScope,
  insertGateDecision,
  insertMinimalOpportunity,
  insertTopic,
  markArticleOverridden,
  markArticleRejectedByGate,
} from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { renderTemplatedLine, t } from '@sortiva/ui'
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

  it('bites: a day the merchant published anyway still names the reason we held it', async () => {
    const scope = accountScope(accountId)
    const opportunity = await insertMinimalOpportunity(
      harness.db,
      scope,
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: 'q-3',
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
    const topic = await insertTopic(
      harness.db,
      scope,
      {
        opportunityId: opportunity.id,
        title: 'Held back, then overruled',
        targetKeyword: 'trail shoe sizing',
        keywordCluster: null,
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'auto',
        whyLine: 'topic.auto',
        scheduledDate: '2026-03-15',
        pinned: false,
        state: 'rejected_by_gate',
      },
      NOW,
    )
    const { rows: article } = await harness.pool.query<{ id: string }>(
      'INSERT INTO articles (account_id, topic_id, title, slug) VALUES ($1,$2,$3,$4) RETURNING id',
      [accountId, topic.id, 'Held back, then overruled', 'held-back'],
    )
    await insertGateDecision(
      harness.db,
      scope,
      {
        topicId: topic.id,
        gate: 3,
        outcome: 'rejected_after_repair',
        scoresJson: { scores: { informationGain: 2 } },
        reasonUserFacing: 'gate3.below_quality_bar',
        promptVersion: 'judge.v1',
        modelId: 'claude-test',
      },
      NOW,
    )
    await markArticleRejectedByGate(harness.db, scope, article[0]!.id)
    await markArticleOverridden(harness.db, scope, article[0]!.id)
    // The override's own row, written a minute later, carries no reason of its
    // own — the refusal it overrules is where the reason lives.
    await insertGateDecision(
      harness.db,
      scope,
      {
        topicId: topic.id,
        gate: 3,
        outcome: 'overridden',
        scoresJson: { scores: { informationGain: 2 } },
        reasonUserFacing: null,
        promptVersion: 'judge.v1',
        modelId: 'claude-test',
      },
      new Date(NOW.getTime() + 60_000),
    )

    const body = calendarResponseSchema.parse(await (await get(accountId, '?from=2026-03-01&to=2026-03-31')).json())
    expect(body.topics[0]?.rejection?.gate).toBe('gate_3')
    // Not a gate-1 fallback invented because the override row has no reason.
    expect(body.topics[0]?.rejection?.reason.templateKey).toBe('gate3.below_quality_bar')
  })

  /**
   * What a merchant actually reads on a held day.
   *
   * The response having a populated `params` object proves nothing on its own:
   * for the life of this feature the key it was filed under and the key the
   * catalogue held were different, so a correct bag of values still rendered
   * "the reasoning for this one isn't available yet". So this drives the real
   * handler and then puts its answer through the real renderer, and asserts on
   * the sentence rather than on the shape of the response.
   */
  const held = async (
    scoresJson: unknown,
    reasonUserFacing: string | null = 'gate3.below_quality_bar',
  ) => {
    const scope = accountScope(accountId)
    const opportunity = await insertMinimalOpportunity(
      harness.db,
      scope,
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: 'q-held',
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
    const topic = await insertTopic(
      harness.db,
      scope,
      {
        opportunityId: opportunity.id,
        title: 'Sizing a wide-fit trail shoe',
        targetKeyword: 'wide fit trail shoes',
        keywordCluster: null,
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'auto',
        whyLine: 'topic.auto',
        scheduledDate: '2026-03-15',
        pinned: false,
        state: 'rejected_by_gate',
      },
      NOW,
    )
    await insertGateDecision(
      harness.db,
      scope,
      {
        topicId: topic.id,
        gate: 3,
        outcome: 'rejected_after_repair',
        scoresJson,
        reasonUserFacing,
        promptVersion: 'judge.v2',
        modelId: 'claude-test',
      },
      NOW,
    )

    const body = calendarResponseSchema.parse(
      await (await get(accountId, '?from=2026-03-01&to=2026-03-31')).json(),
    )
    const reason = body.topics[0]?.rejection?.reason
    if (!reason) throw new Error('the held day carried no reason at all')
    return { reason, line: renderTemplatedLine(reason, t) }
  }

  // The grader's own objection, written by a model. It is the one sentence in
  // the product our words do not compose, and it is always English whatever
  // language the store publishes in.
  const JUSTIFICATION =
    'The comparison section restates the specifications already listed on the product pages and adds no measurement a reader could not find there.'

  it('bites: a held day tells the merchant which criteria failed and what the grader wrote', async () => {
    const { line } = await held({
      scores: { informationGain: 2, actionability: 3 },
      justifications: { informationGain: JUSTIFICATION },
      failed_criteria: ['informationGain'],
      reason_params: { failed_criteria: 'informationGain', first_justification: JUSTIFICATION },
    })

    expect(line.known, 'the reason fell through to the "no reasoning yet" line').toBe(true)
    expect(line.text).not.toBe(t('opportunities.whyUnavailable'))
    expect(line.text).toContain('informationGain')
    expect(line.text).toContain(JUSTIFICATION)
    // Nothing between the grader and the merchant rewrites, truncates or
    // translates the sentence — which is what makes a Danish store's card carry
    // an English objection, because English is what the grader was asked for.
    expect(line.text.endsWith(JUSTIFICATION)).toBe(true)
    expect(line.text).not.toContain('{')
  })

  it('bites: a lint rejection names where the draft tripped', async () => {
    const { line } = await held(
      {
        lint_issues: [{ category: 'near_duplicate', kind: 'similar', location: 'Section 2', detail: 'close to an article published in January' }],
        reason_params: {
          issue_count: 1,
          first_location: 'Section 2',
          first_detail: 'close to an article published in January',
        },
      },
      'gate3.near_duplicate',
    )

    expect(line.known).toBe(true)
    expect(line.text).toContain('close to an article published in January')
    expect(line.text).not.toContain('{')
  })

  it('does not invent values a decision never recorded', async () => {
    // An older row, written before the gate stored its parameters. The sentence
    // renders with its blanks left visible rather than with anything guessed —
    // the honest failure, and the one the guard in `packages/ui` exists to keep
    // from becoming permanent.
    const { reason } = await held({ scores: { informationGain: 2 } })
    expect(reason.params).toEqual({})
  })

  it('drops a recorded value that is not a word or a number', async () => {
    // `scores_json` is free-form, and an object interpolated into a sentence
    // reads to a merchant as "[object Object]".
    const { reason } = await held({
      reason_params: { failed_criteria: 'informationGain', first_justification: { text: 'nested' } },
    })
    expect(reason.params).toEqual({ failed_criteria: 'informationGain' })
  })

  it('rejects a malformed query', async () => {
    const response = await get(accountId, '?from=not-a-date&to=2026-03-31')
    expect(response.status).toBe(422)
  })
})
