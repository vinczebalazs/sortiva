import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { QueryCluster, SeoDataProvider } from '@sortiva/core'
import { silentLogger } from '@sortiva/core'
import { accountScope, schema, type Db } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { MockLlmClient, loadPrompt } from '@sortiva/llm'
import type { PageFetcher } from '@sortiva/providers'
import { rules } from '@sortiva/rules'
import { DbExistingTargetCheck } from '../scan'
import { admitManualTopic } from './admit-manual-topic'
import { generateArticle } from './generate-article'
import { DRAFT_PROMPT_MAJOR_VERSION, JUDGE_PROMPT_MAJOR_VERSION } from './prompts'

/**
 * An operator can move one threshold for one store, without a deploy. These
 * tests hold the two things that has to mean for the gates.
 *
 * **The decision changes, for that store and no other.** A row in
 * `rules_overrides` aimed at one account changes what its topics and drafts are
 * judged by; an account with no row is judged exactly as before.
 *
 * **The record says which numbers judged it.** Every gate decision carries a
 * version string, and the learning loop and every audit read that string as
 * "these were the numbers behind this decision". So a store judged under an
 * override stamps a version that says so — the same file hash with a short
 * suffix over the values that actually won — and a store on the repo file's
 * numbers stamps the bare file hash it has always stamped. The second half is
 * the one that keeps every record written before today readable.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-03-02T07:00:00.000Z')

/** `<sha256 of the config file>+ov.<16 hex>` — the shape the weekly scan established. */
const OVERRIDDEN_VERSION = new RegExp(`^${rules().rulesVersion}\\+ov\\.[0-9a-f]{16}$`)

function versionOf(scoresJson: unknown): unknown {
  return (scoresJson as { rulesVersion?: unknown } | null)?.rulesVersion
}

const uncalledSeo: SeoDataProvider = {
  keywordMetrics: () => Promise.reject(new Error('not expected to be called')),
  serpTop: () => Promise.reject(new Error('not expected to be called')),
  rankedKeywords: () => Promise.reject(new Error('not expected to be called')),
}

/**
 * Gate 2 measures the assembled research pack, and assembling one reaches the
 * search vendor and one competing page. Both are answered here so the gate has
 * something real to measure; neither is what these tests are about.
 */
const packSeo: SeoDataProvider = {
  keywordMetrics: () => Promise.reject(new Error('not expected to be called')),
  serpTop: async () => ({
    data: [{ position: 1, url: 'https://rival.example/guide', domain: 'rival.example', title: 'Water bottle guide' }],
    meta: { endpoint: 'serp_top', cacheHit: false, billable: true, usdCost: 0.01 },
  }),
  rankedKeywords: () => Promise.reject(new Error('not expected to be called')),
}

const packPageFetcher: PageFetcher = {
  fetch: async (request) => ({
    finalUrl: request.url,
    status: 200,
    contentType: 'text/html',
    body: '<h1>Water bottle buying guide</h1><p>Look for a wide mouth and a leakproof lid when choosing a bottle.</p>',
    bytes: 200,
    chain: [request.url],
    headers: {},
  }),
}

describe.skipIf(!available)('a gate threshold moved for one store', () => {
  let ctx: TestDb
  let db: Db
  let overridden: string
  let untouched: string

  beforeAll(async () => {
    ctx = await setupTestDb('generation_gate_rules_overrides')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    overridden = await insertAccount(ctx.pool, 'overridden@example.com')
    untouched = await insertAccount(ctx.pool, 'untouched@example.com')
  })

  async function setOverride(accountId: string | null, key: string, value: unknown): Promise<void> {
    await db.insert(schema.rulesOverrides).values({
      accountId,
      locale: null,
      pageType: null,
      key,
      value,
      updatedBy: 'test-operator',
      updatedAt: NOW,
    })
  }

  // ── Gate 1: topic admission ───────────────────────────────────────────────

  async function seedFamilyWithSubstance(accountId: string, familyId: string): Promise<void> {
    const scope = accountScope(accountId)
    await db.insert(schema.productFamilies).values({
      id: familyId,
      accountId: scope.accountId,
      name: 'Trail running shoes',
      groupingSource: 'collection',
      confidence: 'high',
    })
    for (let i = 0; i < 3; i += 1) {
      const [product] = await db
        .insert(schema.products)
        .values({
          accountId: scope.accountId,
          shopifyProductId: `shopify-${i}`,
          title: `Trail Runner ${i}`,
          familyId,
        })
        .returning()
      await db.insert(schema.productFacts).values({
        productId: product!.id,
        factsJson: {
          material: `mesh variant ${i}`,
          dimensions: `${i + 20} cm`,
          weight: `${240 + i} g`,
          capacity: null,
          compatibility: [`trail ${i}`],
          use_cases_stated: [`long runs ${i}`],
          care: `machine wash ${i}`,
          variant_axes: ['size'],
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

  function gate1Deps() {
    return {
      db,
      existingTargetCheck: new DbExistingTargetCheck({ db, seo: uncalledSeo, now: () => NOW, logger: silentLogger }),
      now: () => NOW,
      logger: silentLogger,
    }
  }

  function cluster(familyId: string): QueryCluster {
    return {
      head: 'best trail running shoes',
      members: [],
      intentClass: 'buying_guide',
      familyIds: [familyId],
    }
  }

  async function admitFor(accountId: string, familyId: string) {
    await seedFamilyWithSubstance(accountId, familyId)
    await db.insert(schema.keywords).values({
      accountId,
      term: 'best trail running shoes',
      language: 'en',
      country: 'us',
      volume: rules().defaults.gates.demand_floor.monthly_search_volume_min * 2,
      source: 'manual',
    })
    return admitManualTopic(gate1Deps(), {
      accountId,
      title: 'Best trail running shoes for wide feet',
      cluster: cluster(familyId),
      scheduledDate: '2026-03-10',
    })
  }

  async function gateDecisionFor(accountId: string, gate: 1 | 2 | 3) {
    const rows = await db
      .select()
      .from(schema.gateDecisions)
      .where(and(eq(schema.gateDecisions.accountId, accountId), eq(schema.gateDecisions.gate, gate)))
    expect(rows).toHaveLength(1)
    return rows[0]!
  }

  it('turns a topic the store would otherwise get into a refusal, and leaves the store next door alone', async () => {
    // The winnability floor: how plausibly this store could rank at all. Raised
    // above the value every store is scored on today, nothing clears it.
    await setOverride(overridden, 'gates.winnability.minimum', 0.9)

    const refused = await admitFor(overridden, '11111111-1111-4111-8111-111111111111')
    expect(refused.outcome).toBe('rejected')
    expect(refused.rejection?.templateKey).toBe('gate1.rejected_not_winnable')
    expect(await gateDecisionFor(overridden, 1)).toMatchObject({ outcome: 'rejected_not_winnable' })

    const admitted = await admitFor(untouched, '22222222-2222-4222-8222-222222222222')
    expect(admitted.outcome).toBe('planned')
    expect(await gateDecisionFor(untouched, 1)).toMatchObject({ outcome: 'admitted' })
  })

  it('stamps the overridden store a version that says so, and the untouched store exactly what it stamped before', async () => {
    await setOverride(overridden, 'gates.winnability.minimum', 0.9)

    await admitFor(overridden, '11111111-1111-4111-8111-111111111111')
    await admitFor(untouched, '22222222-2222-4222-8222-222222222222')

    expect(versionOf((await gateDecisionFor(overridden, 1)).scoresJson)).toMatch(OVERRIDDEN_VERSION)
    // The bare file hash, character for character. Every gate decision recorded
    // before overrides existed carries this string; if it moved here, every one
    // of those records would have to be re-read against a version that no
    // longer means what it meant when it was written.
    expect(versionOf((await gateDecisionFor(untouched, 1)).scoresJson)).toBe(rules().rulesVersion)
  })

  it('stamps two stores given the same override the same string, so a cohort stays visible', async () => {
    const alsoOverridden = await insertAccount(ctx.pool, 'also-overridden@example.com')
    await setOverride(overridden, 'gates.winnability.minimum', 0.9)
    await setOverride(alsoOverridden, 'gates.winnability.minimum', 0.9)

    await admitFor(overridden, '11111111-1111-4111-8111-111111111111')
    await admitFor(alsoOverridden, '33333333-3333-4333-8333-333333333333')

    const first = versionOf((await gateDecisionFor(overridden, 1)).scoresJson)
    expect(first).toMatch(OVERRIDDEN_VERSION)
    expect(versionOf((await gateDecisionFor(alsoOverridden, 1)).scoresJson)).toBe(first)
  })

  it('refuses to run the store rather than quietly ignoring a row that names no threshold', async () => {
    await setOverride(overridden, 'gates.winnability.minimun', 0.9)

    await expect(admitFor(overridden, '11111111-1111-4111-8111-111111111111')).rejects.toThrow(
      /not a threshold this product has/,
    )
  })

  // ── Gate 2: the evidence pack check, before any model call ────────────────

  async function seedGate2Family(accountId: string, familyId: string): Promise<void> {
    const scope = accountScope(accountId)
    await db.insert(schema.productFamilies).values({
      id: familyId,
      accountId: scope.accountId,
      name: 'Water bottles',
      differentiationAxes: ['capacity'],
      groupingSource: 'collection',
      confidence: 'high',
    })
    const materials = ['stainless steel', 'glass', 'tritan plastic']
    const origins = ['Germany', 'Portugal', 'Vietnam']
    for (let i = 0; i < 3; i += 1) {
      const [product] = await db
        .insert(schema.products)
        .values({ accountId: scope.accountId, shopifyProductId: `bottle-${i}`, title: `Bottle ${i}`, familyId })
        .returning()
      await db.insert(schema.productFacts).values({
        productId: product!.id,
        factsJson: {
          material: materials[i],
          dimensions: null,
          weight: null,
          capacity: null,
          compatibility: [],
          use_cases_stated: [],
          care: null,
          variant_axes: [],
          price_range: null,
          certifications: [],
          origin: origins[i],
          verifiable_claims: [],
          fluff_discarded: false,
          fact_count: 2,
        },
        factCount: 2,
        fluffDiscarded: 0,
        promptVersion: 'v1',
        modelId: 'test-model',
      })
    }
  }

  async function seedTopic(accountId: string, familyId: string): Promise<string> {
    const scope = accountScope(accountId)
    const [opportunity] = await db
      .insert(schema.opportunities)
      .values({
        accountId: scope.accountId,
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: 'best water bottles',
        evidenceJson: [],
        impact: 'medium',
        impactScore: 50,
        confidence: 50,
        reasonTemplateKey: 'opportunity.uncovered_commercial_query',
        reasonParamsJson: {},
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
        accountId: scope.accountId,
        opportunityId: opportunity!.id,
        title: 'Best water bottles',
        targetKeyword: 'best water bottles',
        intentClass: 'buying_guide',
        familyIds: [familyId],
        kind: 'new',
        source: 'auto',
        scheduledDate: '2026-03-10',
        state: 'generating',
      })
      .returning()
    return topic!.id
  }

  async function runGate2For(accountId: string, familyId: string) {
    await seedGate2Family(accountId, familyId)
    const topicId = await seedTopic(accountId, familyId)
    const llm = new MockLlmClient()
    const result = await generateArticle(
      {
        db,
        llm,
        seo: packSeo,
        pageFetcher: packPageFetcher,
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
        topicId,
        intentClass: 'buying_guide',
        cluster: { head: 'best water bottles', members: [] },
        targetKeyword: 'best water bottles',
        familyIds: [familyId],
        locale: { languageCode: 'en', countryCode: 'US' },
        linkTaskUrl: null,
      },
    )
    return { result, llm }
  }

  it('holds a draft the store would otherwise get, before a single model call is paid for', async () => {
    // How many distinct things the research has to say before it is worth
    // writing from. Raised past what any pack here could reach.
    await setOverride(overridden, 'gates.evidence_pack_check.distinct_claims_min', 50)

    const held = await runGate2For(overridden, '44444444-4444-4444-8444-444444444444')
    expect(held.result.outcome).toBe('held_thin_pack')
    expect(held.llm.callCount).toBe(0)
    expect(versionOf((await gateDecisionFor(overridden, 2)).scoresJson)).toMatch(OVERRIDDEN_VERSION)

    // The identical catalogue, one store over, with nothing overridden. Gate 2
    // lets it through, and the very next thing the pipeline does is the
    // claim-plan model call — which this bare stub has no answer for. Getting
    // that far is the assertion: the pack was admitted, and no Gate 2 refusal
    // was written.
    await expect(runGate2For(untouched, '55555555-5555-4555-8555-555555555555')).rejects.toThrow(
      /no response for call_type "claim_plan"/,
    )
    const refusals = await db
      .select()
      .from(schema.gateDecisions)
      .where(and(eq(schema.gateDecisions.accountId, untouched), eq(schema.gateDecisions.gate, 2)))
    expect(refusals).toEqual([])
  })

  it('stamps a draft gate on the defaults exactly what the repo file hashes to', async () => {
    // A catalogue too thin for the *unmodified* floor, so Gate 2 holds it and
    // writes the row this assertion reads.
    const familyId = '66666666-6666-4666-8666-666666666666'
    const scope = accountScope(untouched)
    await db.insert(schema.productFamilies).values({
      id: familyId,
      accountId: scope.accountId,
      name: 'Thin family',
      differentiationAxes: [],
      groupingSource: 'collection',
      confidence: 'low',
    })
    const [product] = await db
      .insert(schema.products)
      .values({ accountId: scope.accountId, shopifyProductId: 'thin', title: 'Thin product', familyId })
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
    const topicId = await seedTopic(untouched, familyId)

    const llm = new MockLlmClient()
    const result = await generateArticle(
      {
        db,
        llm,
        seo: packSeo,
        pageFetcher: packPageFetcher,
        claimPlanPrompt: loadPrompt('claim-plan', 1),
        draftPrompt: loadPrompt('draft', DRAFT_PROMPT_MAJOR_VERSION),
        judgePrompt: loadPrompt('judge', JUDGE_PROMPT_MAJOR_VERSION),
        contradictionPrompt: loadPrompt('contradiction', 1),
        revisePrompt: loadPrompt('revise', 1),
        now: () => NOW,
        logger: silentLogger,
      },
      {
        accountId: untouched,
        topicId,
        intentClass: 'buying_guide',
        cluster: { head: 'thin topic', members: [] },
        targetKeyword: 'thin topic',
        familyIds: [familyId],
        locale: { languageCode: 'en', countryCode: 'US' },
        linkTaskUrl: null,
      },
    )

    expect(result.outcome).toBe('held_thin_pack')
    expect(versionOf((await gateDecisionFor(untouched, 2)).scoresJson)).toBe(rules().rulesVersion)
  })

  it('applies a row aimed at every store to a store with no row of its own', async () => {
    await setOverride(null, 'gates.winnability.minimum', 0.9)

    const refused = await admitFor(untouched, '77777777-7777-4777-8777-777777777777')
    expect(refused.outcome).toBe('rejected')
    expect(refused.rejection?.templateKey).toBe('gate1.rejected_not_winnable')
    expect(versionOf((await gateDecisionFor(untouched, 1)).scoresJson)).toMatch(OVERRIDDEN_VERSION)
  })
})
