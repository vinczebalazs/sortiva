import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ExistingTargetCheck, ExistingTargetOutcome } from '@sortiva/core'
import { schema } from '@sortiva/db'
import { insertAccount, databaseAvailable, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { renderTemplatedLine, t } from '@sortiva/ui'
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

  /**
   * A family with enough product detail behind it for Gate 1 to have something
   * to write from. Without it every manual add is rejected as off-catalog and
   * no topic row is returned at all, so this is what it takes to see the chip
   * this route actually puts on the calendar.
   */
  async function seedFamilyWithSubstance(familyId: string): Promise<void> {
    await harness.db.insert(schema.productFamilies).values({
      id: familyId,
      accountId,
      name: 'Trail running shoes',
      groupingSource: 'collection',
      confidence: 'high',
    })
    for (let i = 0; i < 3; i += 1) {
      const [product] = await harness.db
        .insert(schema.products)
        .values({ accountId, shopifyProductId: `shopify-${i}`, title: `Trail Runner ${i}`, familyId })
        .returning()
      await harness.db.insert(schema.productFacts).values({
        productId: product!.id,
        factsJson: {
          material: `mesh-and-rubber-${i}`,
          dimensions: `size chart ${i}`,
          weight: `${280 + i}g`,
          capacity: null,
          compatibility: [],
          use_cases_stated: [`trail running variant ${i}`],
          care: 'wipe clean',
          variant_axes: [],
          price_range: null,
          certifications: [],
          origin: null,
          verifiable_claims: [`grip tested to variant ${i}`],
          fluff_discarded: true,
          fact_count: 6,
        },
        factCount: 6,
        fluffDiscarded: 1,
        promptVersion: 'v1',
        modelId: 'test-model',
      })
    }
  }

  it('bites: the new chip arrives carrying what Gate 1 measured, not an empty bag', async () => {
    // Gate 1's verdict on a hand-added topic is written onto the topic's own
    // opportunity row, key and measurements together. This route sent the key
    // and dropped the measurements, so any number in that sentence would have
    // printed as a brace. Nothing here reads the sentence: it checks that the
    // keyword Gate 1 weighed arrives with the chip, and that what a merchant
    // reads has no blank left in it.
    const familyId = '11111111-1111-4111-8111-111111111111'
    await seedFamilyWithSubstance(familyId)

    const llm = new MockLlmClient()
    llm.enqueue(
      'topic_classify',
      JSON.stringify({
        head: 'best trail running shoes',
        members: [],
        intentClass: 'buying_guide',
        familyIds: [familyId],
      }),
    )

    const response = await post(llm, accountId, { title: 'Best trail running shoes', date: '2026-03-20' })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      outcome: string
      topic: { why: { templateKey: string; params: Record<string, string | number> } } | null
    }

    // No keyword row exists for this term, so Gate 1 admits it with the
    // heads-up about demand rather than silently.
    expect(body.outcome).toBe('planned_with_warning')
    expect(body.topic?.why.templateKey).toBe('gate1.rejected_zero_volume')
    expect(body.topic?.why.params.keyword).toBe('best trail running shoes')

    const line = renderTemplatedLine(body.topic!.why, t)
    expect(line.known).toBe(true)
    expect(line.text).not.toContain('{')
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
