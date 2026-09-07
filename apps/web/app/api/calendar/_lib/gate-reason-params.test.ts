import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { silentLogger, type LlmClient, type SeoDataProvider } from '@sortiva/core'
import { accountScope, schema, type Db } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { loadPrompt, MockLlmClient } from '@sortiva/llm'
import type { PageFetcher } from '@sortiva/providers'
import { rules } from '@sortiva/rules'
import { renderTemplatedLine, t } from '@sortiva/ui'
import { ADMISSION_REASON_PARAMS, placeholdersIn } from '@sortiva/ui/strings/reason-copy'
// Deep imports rather than the `@sortiva/jobs` barrel, which pulls
// `graphile-worker` in through `./runtime` — the same chain the calendar's own
// route avoids.
import { admitManualTopic } from '@sortiva/jobs/generation/admit-manual-topic'
import { generateArticle } from '@sortiva/jobs/generation/generate-article'
import {
  DRAFT_PROMPT_MAJOR_VERSION,
  JUDGE_PROMPT_MAJOR_VERSION,
} from '@sortiva/jobs/generation/prompts'
import { DbExistingTargetCheck } from '@sortiva/jobs/scan/index'
import { withAccount } from '../../auth/_lib/session'
import { makeGetCalendarHandler } from './handlers'

/**
 * What a merchant reads under a day the product stopped, driven all the way
 * from the gate that stopped it.
 *
 * A held day carries two sentences: why it was planned, filled from the
 * opportunity behind it, and why it was stopped, filled from the gate's own
 * decision row. The second one is the subject here. The gate has no column for
 * the values a sentence interpolates, so it folds them into the free-form audit
 * column, and every screen reads them back out of one agreed name there. Gate 3
 * wrote that name; Gate 1 wrote the same values one level deeper, nested inside
 * its reason card, and Gate 2 wrote none at all — so both came back empty and
 * any blank in their sentence would have printed to a merchant as `{keyword}`.
 *
 * Every check below runs the real gate against a real Postgres, asks the real
 * calendar route what the browser would receive, and then **renders the
 * sentence and looks at the words**. Reading the template instead is the exact
 * fault this pair of cards is about: for months the calendar's tests asserted
 * that a key and a params object were present, which was true, while the screen
 * showed the braces.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-03-02T07:00:00.000Z')
const MONTH = '?from=2026-03-01&to=2026-03-31'

/**
 * Gate 1 reaches no vendor at all: nothing here connects Search Console or
 * seeds a domain, so the existing-target check bails out before its proxy
 * fallback would call anyone. A call landing on these is this suite's bug.
 */
const uncalledSeo: SeoDataProvider = {
  keywordMetrics: () => Promise.reject(new Error('not expected to be called')),
  serpTop: () => Promise.reject(new Error('not expected to be called')),
  rankedKeywords: () => Promise.reject(new Error('not expected to be called')),
}

/**
 * Gate 2 runs after the evidence pack is assembled, and assembling one reads
 * the live search results and one rival page. Both are answered from here so
 * the check under test is the pack's thinness rather than a network.
 */
const packSeo: SeoDataProvider = {
  keywordMetrics: () => Promise.reject(new Error('not expected to be called')),
  serpTop: async () => ({
    data: [{ position: 1, url: 'https://rival.example/guide', domain: 'rival.example', title: 'Bottle guide' }],
    meta: { endpoint: 'serp_top', cacheHit: false, billable: true, usdCost: 0.01 },
  }),
  rankedKeywords: () => Promise.reject(new Error('not expected to be called')),
}

const packFetcher: PageFetcher = {
  fetch: async (request) => ({
    finalUrl: request.url,
    status: 200,
    contentType: 'text/html',
    body: '<h1>Bottle guide</h1><p>Look for a wide mouth and a leakproof lid.</p>',
    bytes: 200,
    chain: [request.url],
    headers: {},
  }),
}

describe.skipIf(!available)('the sentence on a day a gate held back', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('web_calendar_gate_reason_params')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'gate-reason-params@example.com')
  })

  const calendar = async () => {
    const route = withAccount(makeGetCalendarHandler({ db }), async () => accountId)
    const response = await route(new Request(`http://localhost/api/calendar${MONTH}`), undefined)
    expect(response.status).toBe(200)
    return (await response.json()) as {
      topics: readonly {
        readonly why: { readonly templateKey: string; readonly params: Record<string, string | number> }
        readonly rejection: {
          readonly gate: string
          readonly reason: { readonly templateKey: string; readonly params: Record<string, string | number> }
        } | null
      }[]
    }
  }

  /** The sentence as the browser would render it, from the response the browser gets. */
  const render = (line: { templateKey: string; params: Record<string, string | number> }) =>
    renderTemplatedLine(line, t)

  /**
   * The values the producer declares it sends for this reason, which is what
   * the sentences are written against. Checked from the producer's own side:
   * deciding what to send by reading the sentence would prove nothing, since
   * the sentence is exactly what has no blanks in it yet.
   */
  const declaredValues = (key: string): readonly string[] => ADMISSION_REASON_PARAMS[key] ?? []

  /**
   * Everything a sentence asks for is filled, and nothing it asks for is left
   * showing. Vacuous only for as long as these eleven sentences carry no
   * blanks; it goes live the moment the copy gains one, which is the whole
   * point of getting the values here first.
   */
  function expectRendersItsValues(
    line: { templateKey: string; params: Record<string, string | number> },
  ): void {
    const rendered = render(line)
    expect(rendered.known, `${line.templateKey} has no sentence at all`).toBe(true)
    expect(rendered.text, `${line.templateKey} rendered as "${rendered.text}"`).not.toContain('{')
    for (const name of placeholdersIn(line.templateKey)) {
      expect(
        rendered.text,
        `${line.templateKey} has a blank for {${name}} and the gate's value for it never arrived`,
      ).toContain(String(line.params[name]))
    }
  }

  // ---- Gate 1: a topic the merchant typed in, stopped before anything was written. ----

  async function seedThinFamily(familyId: string): Promise<void> {
    await db.insert(schema.productFamilies).values({
      id: familyId,
      accountId,
      name: 'Barely described bottles',
      groupingSource: 'collection',
      confidence: 'low',
    })
    const [product] = await db
      .insert(schema.products)
      .values({ accountId, shopifyProductId: 'shopify-thin-1', title: 'A bottle', familyId })
      .returning()
    await db.insert(schema.productFacts).values({
      productId: product!.id,
      factsJson: {
        material: 'plastic',
        dimensions: null,
        weight: null,
        capacity: null,
        compatibility: [],
        use_cases_stated: [],
        care: null,
        variant_axes: [],
        price_range: null,
        certifications: [],
        origin: null,
        verifiable_claims: [],
        fluff_discarded: false,
        fact_count: 1,
      },
      factCount: 1,
      fluffDiscarded: 0,
      promptVersion: 'v1',
      modelId: 'test-model',
    })
  }

  const admitDeps = () => ({
    db,
    existingTargetCheck: new DbExistingTargetCheck({ db, seo: uncalledSeo, now: () => NOW, logger: silentLogger }),
    now: () => NOW,
    logger: silentLogger,
  })

  async function heldByGate1(): Promise<void> {
    const familyId = '11111111-1111-4111-8111-111111111111'
    await seedThinFamily(familyId)
    await db.insert(schema.keywords).values({
      accountId,
      term: 'best insulated bottles',
      language: 'en',
      country: 'us',
      volume: rules().defaults.gates.demand_floor.monthly_search_volume_min * 3,
      source: 'manual',
    })
    const result = await admitManualTopic(admitDeps(), {
      accountId,
      title: 'Best insulated bottles',
      cluster: { head: 'best insulated bottles', members: [], intentClass: 'buying_guide', familyIds: [familyId] },
      scheduledDate: '2026-03-10',
    })
    expect(result.outcome).toBe('rejected')
    expect(result.rejection?.templateKey).toBe('gate1.held_insufficient_substance')
  }

  it('bites: a Gate 1 hold reaches the screen carrying what it measured, not an empty bag', async () => {
    await heldByGate1()

    const [day] = (await calendar()).topics
    expect(day?.rejection?.gate).toBe('gate_1')

    const reason = day!.rejection!.reason
    expect(reason.templateKey).toBe('gate1.held_insufficient_substance')

    // The failure this card removes: every one of these was measured, stored,
    // and unreachable, because the read-back looks one level above where Gate 1
    // was putting them.
    expect(Object.keys(reason.params).sort()).toEqual([...declaredValues(reason.templateKey)].sort())
    expect(reason.params.keyword).toBe('best insulated bottles')
    expect(reason.params.distinct_facts_required).toBe(
      rules().defaults.gates.substance_floor.distinct_facts_min,
    )
    expect(typeof reason.params.products_needing_detail).toBe('number')

    expectRendersItsValues(reason)
  })

  it('bites: both sentences on a held day are filled from the same measurements', async () => {
    // A hand-added topic writes Gate 1's verdict twice — onto the opportunity,
    // whose reason explains why the day is there at all, and onto the gate
    // decision, which explains why it stopped. The two rendered sentences are
    // the same words, so they must be the same words *with the same numbers in
    // them*; before this card the first was full and the second empty, which is
    // precisely why the copy was written with no numbers at all.
    await heldByGate1()

    const [day] = (await calendar()).topics
    const planned = day!.why
    const stopped = day!.rejection!.reason

    expect(stopped.templateKey).toBe(planned.templateKey)
    expect(stopped.params).toEqual(planned.params)
    expect(render(stopped).text).toBe(render(planned).text)
    expect(render(stopped).text).not.toContain('{')
  })

  it('stores what its sentence will need for every Gate 1 verdict that can hold a day', async () => {
    // Off-catalog is the other verdict a merchant can reach by hand, and it
    // carries a different set of values — so this proves the fix is in the
    // writer rather than in one branch of the gate.
    await db.insert(schema.keywords).values({
      accountId,
      term: 'unrelated to anything sold here',
      language: 'en',
      country: 'us',
      volume: rules().defaults.gates.demand_floor.monthly_search_volume_min * 3,
      source: 'manual',
    })
    const result = await admitManualTopic(admitDeps(), {
      accountId,
      title: 'Something off catalog',
      cluster: { head: 'unrelated to anything sold here', members: [], intentClass: 'informational', familyIds: [] },
      scheduledDate: '2026-03-11',
    })
    expect(result.outcome).toBe('rejected')

    const reason = (await calendar()).topics[0]!.rejection!.reason
    expect(reason.templateKey).toBe('gate1.rejected_off_catalog')
    expect(Object.keys(reason.params).sort()).toEqual([...declaredValues(reason.templateKey)].sort())
    expect(reason.params.keyword).toBe('unrelated to anything sold here')
    expectRendersItsValues(reason)
  })

  // ---- Gate 2: the research came back saying the same thing over and over. ----

  async function heldByGate2(): Promise<void> {
    const familyId = '22222222-2222-4222-8222-222222222222'
    await seedThinFamily(familyId)

    const [opportunity] = await db
      .insert(schema.opportunities)
      .values({
        accountId,
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: 'thin topic',
        evidenceJson: [],
        impact: 'medium',
        impactScore: 50,
        confidence: 50,
        reasonTemplateKey: 'uncovered_commercial_query.create',
        reasonParamsJson: { volume: 1900 },
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
        title: 'Thin topic',
        targetKeyword: 'thin topic',
        intentClass: 'buying_guide',
        familyIds: [familyId],
        kind: 'new',
        source: 'auto',
        whyLine: 'uncovered_commercial_query.create',
        scheduledDate: '2026-03-12',
        state: 'generating',
      })
      .returning()

    const llm: LlmClient = new MockLlmClient()
    const result = await generateArticle(
      {
        db,
        llm,
        seo: packSeo,
        pageFetcher: packFetcher,
        claimPlanPrompt: loadPrompt('claim-plan', 1),
        draftPrompt: loadPrompt('draft', DRAFT_PROMPT_MAJOR_VERSION),
        judgePrompt: loadPrompt('judge', JUDGE_PROMPT_MAJOR_VERSION),
        contradictionPrompt: loadPrompt('contradiction', 1),
        revisePrompt: loadPrompt('revise', 1),
        now: () => NOW,
        logger: silentLogger,
      },
      {
        accountId,
        topicId: topic!.id,
        intentClass: 'buying_guide',
        cluster: { head: 'thin topic', members: [] },
        targetKeyword: 'thin topic',
        familyIds: [familyId],
        locale: { languageCode: 'en', countryCode: 'US' },
        linkTaskUrl: null,
      },
    )
    expect(result.outcome).toBe('held_thin_pack')

    const decisions = await db
      .select()
      .from(schema.gateDecisions)
      .where(and(eq(schema.gateDecisions.accountId, accountId), eq(schema.gateDecisions.gate, 2)))
    expect(decisions).toHaveLength(1)
  }

  it('bites: a Gate 2 hold reaches the screen carrying what it measured, which it used to record nowhere', async () => {
    await heldByGate2()

    const [day] = (await calendar()).topics
    expect(day?.rejection?.gate).toBe('gate_2')

    const reason = day!.rejection!.reason
    expect(reason.templateKey).toBe('gate2.held_thin_pack')

    // Gate 2 had all four of these in hand and stored none of them, so the
    // sentence explaining the one check that reads the merchant's own product
    // copy could never say how thin it found it.
    expect(Object.keys(reason.params).sort()).toEqual([...declaredValues(reason.templateKey)].sort())
    expect(reason.params.distinct_claims_min).toBe(
      rules().defaults.gates.evidence_pack_check.distinct_claims_min,
    )
    expect(reason.params.boilerplate_ratio_max).toBe(
      rules().defaults.gates.evidence_pack_check.boilerplate_ratio_max,
    )
    expect(typeof reason.params.distinct_claims).toBe('number')

    expectRendersItsValues(reason)
  })

  it('leaves the day’s own explanation filled from the opportunity, which is a different row', async () => {
    // The two sentences come from two places, and a Gate 2 hold is the case
    // where they legitimately differ — the day was planned from an unserved
    // search and stopped for a thin evidence pack. Both must still render whole.
    await heldByGate2()

    const [day] = (await calendar()).topics
    expect(day!.why.templateKey).toBe('uncovered_commercial_query.create')
    expect(render(day!.why).text).toContain('1900')
    expect(render(day!.why).text).not.toContain('{')
    expect(render(day!.rejection!.reason).text).not.toContain('{')
  })
})
