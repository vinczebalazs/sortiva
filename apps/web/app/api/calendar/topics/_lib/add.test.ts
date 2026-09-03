import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ExistingTargetCheck, ExistingTargetOutcome } from '@sortiva/core'
import { insertAccount, databaseAvailable, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { MockLlmClient, loadPrompt } from '@sortiva/llm'
import { withAccount } from '../../../auth/_lib/session'
import { makeAddTopicHandler, type AddTopicDeps } from './add'

const available = await databaseAvailable()
const NOW = new Date('2026-03-10T08:00:00.000Z')
const PROMPT = loadPrompt('topic-classify', 1)

const noMatch: ExistingTargetCheck = {
  async check(): Promise<ExistingTargetOutcome> {
    return { match: 'none' }
  },
}

describe.skipIf(!available)('POST /api/calendar/topics', () => {
  let harness: TestDb
  let accountId: string

  beforeAll(async () => {
    harness = await setupTestDb('web_calendar_add')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    accountId = await insertAccount(harness.pool, 'calendar-add@example.com')
    await harness.pool.query(
      'INSERT INTO subscriptions (account_id, stripe_subscription_id, price_id, status) VALUES ($1, $2, $3, $4)',
      [accountId, 'sub_test', 'price_test', 'active'],
    )
  })

  function deps(llm: MockLlmClient): AddTopicDeps {
    return { db: harness.db, llm, prompt: PROMPT, existingTargetCheck: noMatch, now: () => NOW }
  }

  const post = (llm: MockLlmClient, id: string | null, body: unknown) =>
    withAccount(makeAddTopicHandler(deps(llm)), async () => id)(
      new Request('http://localhost/api/calendar/topics', { method: 'POST', body: JSON.stringify(body) }),
      undefined,
    )

  it('classifies and admits a typed title', async () => {
    const llm = new MockLlmClient()
    llm.enqueue(
      'topic_classify',
      JSON.stringify({ head: 'best trail running shoes', members: [], intentClass: 'buying_guide', familyIds: [] }),
    )

    const response = await post(llm, accountId, { title: 'Best trail running shoes', date: '2026-03-20' })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { outcome: string; rejection: { templateKey: string } | null }
    // Off-catalog: no families exist for this fresh account, so an empty
    // familyIds classification is the honest answer and Gate 1 rejects it —
    // the model call itself is what this test proves reached the handler.
    expect(body.outcome).toBe('rejected')
    expect(body.rejection?.templateKey).toBe('gate1.rejected_off_catalog')
    expect(llm.countOf('topic_classify')).toBe(1)
  })

  it('409s a past date before ever calling the model', async () => {
    const llm = new MockLlmClient()
    const response = await post(llm, accountId, { title: 'Best trail running shoes', date: '2026-01-01' })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('calendar_date_in_past')
    expect(llm.callCount).toBe(0)
  })

  it('rejects a malformed body', async () => {
    const llm = new MockLlmClient()
    const response = await post(llm, accountId, { title: '' })
    expect(response.status).toBe(422)
  })

  it('402s an account with no active subscription, before ever calling the model', async () => {
    const unpaid = await insertAccount(harness.pool, 'calendar-add-unpaid@example.com')
    const llm = new MockLlmClient()

    const response = await post(llm, unpaid, { title: 'Best trail running shoes', date: '2026-03-20' })
    expect(response.status).toBe(402)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('entitlement_inactive')
    expect(llm.callCount).toBe(0)
  })

  it('409s adding onto a day that already has a topic, before ever calling the model', async () => {
    const first = new MockLlmClient()
    first.enqueue(
      'topic_classify',
      JSON.stringify({ head: 'best trail running shoes', members: [], intentClass: 'buying_guide', familyIds: [] }),
    )
    await post(first, accountId, { title: 'Best trail running shoes', date: '2026-03-20' })

    const second = new MockLlmClient()
    const response = await post(second, accountId, { title: 'Something else entirely', date: '2026-03-20' })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('calendar_day_occupied')
    expect(second.callCount).toBe(0)
  })
})
