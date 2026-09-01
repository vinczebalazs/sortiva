import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockPosthogCapture } from '@sortiva/providers'
import {
  StubCatalogEvents,
  StubExistingTargetCheck,
  StubJudgeLite,
  StubNotificationEmitter,
  StubOpportunitySource,
  StubTopicScheduler,
} from './doubles'
import {
  FIXTURE_ACCOUNT_ID,
  fixtureCreateOpportunity,
  fixtureOpportunities,
  fixtureQueryCluster,
} from './fixtures'
import { resetStubRegistry, wiredStubs } from './stubs'
import { accountAttribution } from './analytics'

/**
 * Every contract has a double and a fixture, and every double behaves as the
 * build plan's "stub behaviour until filled" column specifies.
 */

let capture: MockPosthogCapture

beforeEach(() => {
  resetStubRegistry()
  capture = new MockPosthogCapture()
})

afterEach(() => {
  resetStubRegistry()
})

describe('stub registry', () => {
  it('registers every seam, each naming the card that fills it', () => {
    new StubExistingTargetCheck()
    new StubOpportunitySource()
    new StubTopicScheduler()
    new StubJudgeLite()
    new StubCatalogEvents()
    new StubNotificationEmitter()

    const stubs = wiredStubs()
    expect(stubs.map((s) => s.contract).sort()).toEqual([
      'CatalogEvents',
      'JudgeLite',
      'NotificationEmitter',
      'OpportunitySource',
      'TopicScheduler',
      'existingTargetCheck',
    ])
    expect(stubs.every((s) => s.filledBy && s.behaviour && s.mustBeGoneBy)).toBe(true)
  })

  it('emits stub_used with the contract name on every served call', async () => {
    const check = new StubExistingTargetCheck(capture)
    await check.check(fixtureQueryCluster, FIXTURE_ACCOUNT_ID)

    const [event] = capture.of('stub_used')
    expect(event!.properties).toMatchObject({
      contract: 'existingTargetCheck',
      method: 'check',
    })
  })
})

describe('existingTargetCheck stub', () => {
  it('returns no_match, which is why it must be gone by M3 (main §7.7, invariant 6)', async () => {
    const check = new StubExistingTargetCheck(capture)
    expect(await check.check(fixtureQueryCluster, FIXTURE_ACCOUNT_ID)).toEqual({ match: 'none' })
    expect(wiredStubs()[0]!.mustBeGoneBy).toBe('M3')
  })
})

describe('OpportunitySource stub', () => {
  it('returns only auto-accepted content work — CREATE and REFRESH (main §7.9)', async () => {
    const source = new StubOpportunitySource(fixtureOpportunities, capture)
    const result = await source.acceptedContentOpportunities(FIXTURE_ACCOUNT_ID)

    expect(result.map((o) => o.recommendedAction)).toEqual(['CREATE'])
    // The OPTIMIZE and HOLD fixtures are excluded: OPTIMIZE is user-initiated,
    // HOLD never executes.
    expect(result.map((o) => o.id)).not.toContain(fixtureOpportunities[2]!.id)
  })
})

describe('TopicScheduler stub', () => {
  it('records the intent and honours an explicit date', async () => {
    const scheduler = new StubTopicScheduler(capture)
    const topic = await scheduler.schedule(fixtureCreateOpportunity, '2026-03-10')

    expect(topic.scheduledFor).toBe('2026-03-10')
    expect(topic.opportunityId).toBe(fixtureCreateOpportunity.id)
    expect(scheduler.scheduled).toHaveLength(1)
  })
})

describe('JudgeLite stub', () => {
  it('passes with the §8.4 floors rather than perfect scores', async () => {
    const judge = new StubJudgeLite(undefined, capture)
    const verdict = await judge.grade({}, {})

    expect(verdict.passed).toBe(true)
    // Invariant 11 gates on the minimum: fixtures at the floor keep a consumer's
    // test honest, where straight 5s would let a broken gate look fine.
    expect(verdict.scores.informationGain).toBe(4)
    expect(verdict.scores.structure).toBe(3)
  })
})

describe('CatalogEvents stub', () => {
  it('replays fixture events and advances a cursor', async () => {
    const events = new StubCatalogEvents(undefined, capture)
    const first = await events.since(FIXTURE_ACCOUNT_ID)
    expect(first.events).toHaveLength(2)

    const second = await events.since(FIXTURE_ACCOUNT_ID, first.cursor)
    expect(second.events).toHaveLength(0)
  })
})

describe('NotificationEmitter stub', () => {
  it('enforces the (account, type, dedupe_key) uniqueness a retry depends on', async () => {
    const emitter = new StubNotificationEmitter(capture)
    const attribution = accountAttribution(FIXTURE_ACCOUNT_ID, 'example.com')

    const first = await emitter.emit('article_published', { articleId: 'a1' }, 'a1', attribution)
    const second = await emitter.emit('article_published', { articleId: 'a1' }, 'a1', attribution)

    expect(first.created).toBe(true)
    // The constraint makes the second a no-op, which is what stops a retried
    // publish job ringing the bell twice.
    expect(second.created).toBe(false)
    expect(emitter.of('article_published')).toHaveLength(1)
  })

  it('carries references only, never rendered text (tech §1.2)', async () => {
    const emitter = new StubNotificationEmitter(capture)
    await emitter.emit(
      'topic_held_by_gate',
      { topicId: 't1', gateDecisionId: 'g1' },
      't1',
      accountAttribution(FIXTURE_ACCOUNT_ID),
    )

    const [emitted] = emitter.of('topic_held_by_gate')
    expect(Object.keys(emitted!.refs).sort()).toEqual(['gateDecisionId', 'topicId'])
  })
})
