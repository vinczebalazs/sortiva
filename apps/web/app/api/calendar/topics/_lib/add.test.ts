import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ExistingTargetCheck, ExistingTargetOutcome } from '@sortiva/core'
import { schema } from '@sortiva/db'
import { insertAccount, databaseAvailable, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { renderTemplatedLine, t } from '@sortiva/ui'
import { MockLlmClient, loadPrompt } from '@sortiva/llm'
import { rules } from '@sortiva/rules'
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
  async function seedFamilyWithSubstance(familyId: string, store: string = accountId): Promise<void> {
    await harness.db.insert(schema.productFamilies).values({
      id: familyId,
      accountId: store,
      name: 'Trail running shoes',
      groupingSource: 'collection',
      confidence: 'high',
    })
    for (let i = 0; i < 3; i += 1) {
      const [product] = await harness.db
        .insert(schema.products)
        .values({ accountId: store, shopifyProductId: `shopify-${i}`, title: `Trail Runner ${i}`, familyId })
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

  /**
   * The store's own market, as its profile records it. The minimum search
   * volume a topic has to clear is set per language, so this row is what
   * decides which bar a hand-typed topic is held to.
   */
  async function seedPersona(store: string, language: string, country: string): Promise<void> {
    await harness.db.insert(schema.personas).values({
      accountId: store,
      description: 'A running shop.',
      language,
      country,
      promptVersion: 'persona.v1',
      modelId: 'test-model',
    })
  }

  /** A stored search volume the two markets disagree about the meaning of. */
  async function seedKeyword(store: string, language: string, volume: number): Promise<void> {
    await harness.db.insert(schema.keywords).values({
      accountId: store,
      term: 'best trail running shoes',
      language,
      country: language === 'da' ? 'dk' : 'us',
      volume,
      source: 'manual',
    })
  }

  async function addTopicFor(store: string, familyId: string) {
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
    const response = await post(llm, store, { title: 'Best trail running shoes', date: '2026-03-20' })
    expect(response.status).toBe(200)
    return (await response.json()) as {
      outcome: string
      topic: { why: { templateKey: string; params: Record<string, string | number> } } | null
    }
  }

  /**
   * Thirty searches a month is a subject worth writing about in Danish and
   * nothing much in English, and the thresholds say so. A hand-typed topic was
   * measured against the English bar whatever market the store sells into,
   * because this route never told the gate which language it was judging — and
   * the merchant was then shown that foreign number as the bar they missed.
   */
  it("judges a typed topic by the store's own market", async () => {
    const danish = accountId
    const english = await insertAccount(harness.pool, 'calendar-add-english@example.com')
    await harness.pool.query(
      'INSERT INTO subscriptions (account_id, stripe_subscription_id, price_id, status) VALUES ($1, $2, $3, $4)',
      [english, 'sub_test_en', 'price_test', 'active'],
    )

    const danishFamily = '33333333-3333-4333-8333-333333333333'
    const englishFamily = '44444444-4444-4444-8444-444444444444'
    await seedFamilyWithSubstance(danishFamily, danish)
    await seedPersona(danish, 'da', 'DK')
    await seedKeyword(danish, 'da', 30)
    await seedFamilyWithSubstance(englishFamily, english)
    await seedPersona(english, 'en', 'US')
    await seedKeyword(english, 'en', 30)

    // Thirty clears the Danish floor, so the topic is planned with nothing to
    // warn about.
    const inDenmark = await addTopicFor(danish, danishFamily)
    expect(inDenmark.outcome).toBe('planned')
    expect(inDenmark.topic?.why.templateKey).not.toBe('gate1.rejected_zero_volume')

    // The same thirty is under the English floor, so that merchant is warned
    // about demand — and the number they are shown is their own market's.
    const inEngland = await addTopicFor(english, englishFamily)
    expect(inEngland.outcome).toBe('planned_with_warning')
    expect(inEngland.topic?.why.templateKey).toBe('gate1.rejected_zero_volume')
    expect(inEngland.topic?.why.params.monthly_search_volume_min).toBe(
      rules().defaults.gates.demand_floor.monthly_search_volume_min,
    )
  })

  /**
   * The other half of the same omission: an operator can move a threshold for
   * one language, and a route that names no language is a route those rows
   * never reach. Rows aimed at the store, or at every store, always did reach
   * it — which is what made this easy to miss.
   */
  it("lets an override aimed at the store's language reach the gate", async () => {
    const familyId = '55555555-5555-4555-8555-555555555555'
    await seedFamilyWithSubstance(familyId)
    await seedPersona(accountId, 'da', 'DK')
    await seedKeyword(accountId, 'da', 30)

    await harness.db.insert(schema.rulesOverrides).values({
      accountId: null,
      locale: 'da',
      pageType: null,
      key: 'gates.demand_floor.monthly_search_volume_min',
      value: 500,
      updatedBy: 'test-operator',
      updatedAt: NOW,
    })

    const result = await addTopicFor(accountId, familyId)
    expect(result.outcome).toBe('planned_with_warning')
    expect(result.topic?.why.templateKey).toBe('gate1.rejected_zero_volume')
    expect(result.topic?.why.params.monthly_search_volume_min).toBe(500)
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
