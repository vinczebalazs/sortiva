import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ACCOUNT_OPTIMIZE_PAUSED_FLAG,
  silentLogger,
  type CoverageAnalysisOutput,
  type JudgeLite,
  type JudgeVerdict,
  type LlmClient,
  type LlmRequest,
  type LlmResult,
  type OptimizeRecommendation,
} from '@sortiva/core'
import {
  accountScope,
  insertMinimalOpportunity,
  latestOptimizeRecommendation,
  listOptimizeTasks,
  storeOptimizeRecommendation,
  tripAccountFlag,
  upsertStorePages,
  type Db,
  type OpportunityRow,
} from '@sortiva/db'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { MockPageFetcher, MockSeoDataProvider } from '@sortiva/providers'
import { rules } from '@sortiva/rules'
import { generateOptimizeRecommendation } from './generate'

/**
 * The whole OPTIMIZE pipeline against a real database: the merchant's page and
 * the pages above it go in, and either a recommendation every citation of which
 * resolves comes out, or a `failed_validation` record and nothing else.
 *
 * T6.2 done-when: "every `facts_used` resolves in fixture output".
 */

const available = await databaseAvailable()

const NOW = new Date('2026-09-03T09:00:00.000Z')
const PAGE = 'https://shop.example/collections/hiking-boots'
const QUERY = 'waterproof hiking boots'
const FAMILY_ID = '33333333-3333-4333-8333-333333333333'

const RIVALS = [1, 2, 3, 4, 5].map((n) => ({
  position: n,
  url: `https://rival${n}.example/boots`,
  domain: `rival${n}.example`,
  title: `Best hiking boots ${n}`,
}))

function coverageAnswer(): CoverageAnalysisOutput {
  const covering = (count: number, heading: string) =>
    RIVALS.slice(0, count).map((rival) => ({ url: rival.url, heading }))
  return {
    subtopics: [
      {
        name: 'waterproofing',
        presentOnOurPage: false,
        ourEvidence: null,
        competitors: covering(5, 'Waterproofing'),
      },
      { name: 'sizing', presentOnOurPage: false, ourEvidence: null, competitors: covering(3, 'Sizing') },
    ],
  }
}

/** A grounded recommendation: every citation is an address the pack actually holds. */
function goodRecommendation(): OptimizeRecommendation {
  return {
    title_tag: {
      current: 'Hiking boots',
      suggested: 'Waterproof hiking boots, sized for wide feet',
      rationale_key: 'ctr_below_curve',
    },
    meta_description: {
      current: 'Our hiking boots',
      suggested: 'Boots in full-grain leather, with a sizing guide and wet-weather advice.',
      rationale_key: null,
    },
    headings: [{ op: 'add', level: 2, text: 'How waterproof are they', after: 'Our range' }],
    sections: [
      {
        heading: 'How waterproof are they',
        suggested_copy: 'Each pair uses a full-grain leather upper, which sheds water on a wet day out.',
        facts_used: ['subtopic:waterproofing', 'product:PRODUCT_ID/material'],
        gap_source: 'serp',
      },
    ],
    faq: [
      {
        q: 'What size should I take?',
        a: 'These come in half sizes; the family differs mainly by width.',
        facts_used: ['subtopic:sizing', `family:${FAMILY_ID}/axis:width`],
      },
    ],
    internal_links: { add_from: [], add_to: [] },
    intent_note: 'The page never says how these perform in the wet, which is what the search is about.',
  }
}

/** The same recommendation, citing one address nobody gave it. */
function ungroundedRecommendation(): OptimizeRecommendation {
  const good = goodRecommendation()
  return {
    ...good,
    faq: [
      {
        q: 'Are these vegan?',
        a: 'Yes — the upper is a synthetic microfibre.',
        facts_used: ['product:invented/vegan'],
      },
    ],
  }
}

/** Routes by call type, so one client can stand in for the whole pipeline. */
class RoutingLlmClient implements LlmClient {
  readonly requests: LlmRequest[] = []

  constructor(private readonly answers: Record<string, unknown[]>) {}

  async complete<T>(request: LlmRequest): Promise<LlmResult<T>> {
    this.requests.push(request)
    const queue = this.answers[request.callType]
    if (!queue || queue.length === 0) {
      throw new Error(`no stub answer queued for ${request.callType}`)
    }
    const output = queue.length === 1 ? queue[0] : queue.shift()
    return {
      output: output as T,
      text: JSON.stringify(output),
      modelId: 'claude-sonnet-5',
      promptVersion: request.promptVersion,
      cacheHit: false,
      usage: { inputTokens: 900, outputTokens: 600, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      usdCost: 0.01,
      latencyMs: 10,
      attempts: 1,
    }
  }

  countOf(callType: string): number {
    return this.requests.filter((request) => request.callType === callType).length
  }
}

class StubJudge implements JudgeLite {
  readonly graded: unknown[] = []

  constructor(private readonly scores: Record<string, number>) {}

  async grade(recommendation: unknown): Promise<JudgeVerdict> {
    this.graded.push(recommendation)
    return {
      passed: true,
      scores: this.scores as JudgeVerdict['scores'],
      justifications: { factualGrounding: 'traceable', searchIntentMatch: 'on point' },
      promptVersion: 'optimize-judge.v1',
      modelId: 'claude-sonnet-5',
    }
  }
}

let harness: TestDb
let db: Db
let accountId: string
let productId: string

beforeAll(async () => {
  if (!available) throw new Error('Postgres is not reachable. Run `pnpm db:up` first.')
  harness = await setupTestDb('optimize_generate')
  db = harness.db
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
  accountId = await insertAccount(harness.pool, 'optimize@example.com')

  await harness.pool.query(
    `INSERT INTO personas (account_id, description, product_categories, language, country, audience, tone, prompt_version, model_id)
     VALUES ($1, 'A shop selling hiking boots.', ARRAY['boots'], 'en', 'GB', 'hillwalkers', 'plain', 'persona.v1', 'test-model')`,
    [accountId],
  )
  await harness.pool.query(
    `INSERT INTO product_families (id, account_id, name, differentiation_axes, grouping_source, confidence)
     VALUES ($1, $2, 'Hiking boots', ARRAY['width'], 'collection', 'high')`,
    [FAMILY_ID, accountId],
  )
  const inserted = await harness.pool.query<{ id: string }>(
    `INSERT INTO products (account_id, shopify_product_id, title, family_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [accountId, 'gid://shopify/Product/1', 'Fell Walker', FAMILY_ID],
  )
  productId = inserted.rows[0]!.id
  await harness.pool.query(
    `INSERT INTO product_facts (product_id, facts_json, fact_count, fluff_discarded, prompt_version, model_id)
     VALUES ($1, $2::jsonb, 2, 0, 'distill.v1', 'test-model')`,
    [
      productId,
      JSON.stringify({
        material: 'full-grain leather',
        dimensions: null,
        weight: '520 g',
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
        fact_count: 2,
      }),
    ],
  )

  await upsertStorePages(db, accountScope(accountId), [
    {
      url: PAGE,
      pageType: 'collection',
      handle: 'hiking-boots',
      shopifyId: 'gid://shopify/Collection/1',
      title: 'Hiking boots',
      seoTitle: 'Hiking boots',
      seoDescription: 'Our hiking boots',
      headings: ['Our range'],
      bodyHtml: '<p>Browse our hiking boots. Free delivery over £50.</p>',
      outboundInternalLinks: [],
      familyIds: [FAMILY_ID],
      checksum: 'checksum-v1',
    },
    {
      url: 'https://shop.example/pages/boot-care',
      pageType: 'page',
      handle: 'boot-care',
      shopifyId: 'gid://shopify/Page/2',
      title: 'Caring for your boots',
      seoTitle: null,
      seoDescription: null,
      headings: [],
      bodyHtml: '<p>Dry them slowly.</p>',
      outboundInternalLinks: [],
      familyIds: [FAMILY_ID],
      checksum: 'checksum-care',
    },
  ])
})

async function optimizeOpportunity(): Promise<OpportunityRow> {
  return insertMinimalOpportunity(
    db,
    accountScope(accountId),
    {
      signalType: 'existing_page_intent_gap',
      entityType: 'url',
      entityRef: PAGE,
      evidenceJson: [{ key: 'query_cluster', value: QUERY, source: 'gsc' }],
      recommendedAction: 'optimize',
      status: 'executing',
      reasonTemplateKey: 'opportunity.existing_page_intent_gap',
      reasonParams: {},
      limitedIntelligence: false,
      rulesVersion: rules().rulesVersion,
    },
    NOW,
  )
}

async function statusOf(opportunityId: string): Promise<string | undefined> {
  const { rows } = await harness.pool.query<{ status: string }>(
    'SELECT status FROM opportunities WHERE id = $1',
    [opportunityId],
  )
  return rows[0]?.status
}

function fixtures(recommendations: unknown[], scores = { factualGrounding: 4, searchIntentMatch: 4 }) {
  const seo = new MockSeoDataProvider({ serp: { [QUERY]: RIVALS } })
  const pageFetcher = new MockPageFetcher()
  for (const rival of RIVALS) {
    pageFetcher.on(rival.url, '<h2>Waterproofing</h2><p>Gore-Tex keeps water out.</p>')
  }
  const llm = new RoutingLlmClient({
    intent_gap: [coverageAnswer()],
    optimize_reco: recommendations,
  })
  const judge = new StubJudge(scores)
  return {
    seo,
    pageFetcher,
    llm,
    judge,
    deps: {
      db,
      seo,
      pageFetcher,
      llm,
      coveragePrompt: { version: 'intent-gap.v1', text: 'compare the pages' },
      recommendationPrompt: { version: 'optimize-reco.v1', text: 'suggest edits' },
      judge: () => judge,
      now: () => NOW,
      logger: silentLogger,
    },
  }
}

/** The stub cites the product by the id the database chose, which is only known at run time. */
function withProductId(recommendation: OptimizeRecommendation): OptimizeRecommendation {
  return JSON.parse(
    JSON.stringify(recommendation).replaceAll('PRODUCT_ID', productId),
  ) as OptimizeRecommendation
}

describe.skipIf(!available)('an OPTIMIZE generation', () => {
  it('produces a recommendation whose every citation resolves to the evidence pack', async () => {
    const opportunity = await optimizeOpportunity()
    const f = fixtures([withProductId(goodRecommendation())])

    const outcome = await generateOptimizeRecommendation(f.deps, {
      accountId,
      opportunityId: opportunity.id,
    })

    expect(outcome.status).toBe('generated')
    if (outcome.status !== 'generated') return
    expect(outcome.attempts).toBe(1)

    const cited = [
      ...outcome.recommendation.sections.flatMap((section) => section.facts_used),
      ...outcome.recommendation.faq.flatMap((entry) => entry.facts_used),
    ]
    expect(cited).toEqual([
      'subtopic:waterproofing',
      `product:${productId}/material`,
      'subtopic:sizing',
      `family:${FAMILY_ID}/axis:width`,
    ])

    const stored = await latestOptimizeRecommendation(db, accountScope(accountId), opportunity.id)
    expect(stored?.state).toBe('valid')
    expect(stored?.promptVersion).toBe('optimize-reco.v1')
    expect(stored?.modelId).toBe('claude-sonnet-5')
    expect(stored?.rulesVersion).toBe(rules().rulesVersion)

    // The units the merchant marks applied one at a time.
    const tasks = await listOptimizeTasks(db, accountScope(accountId), opportunity.id)
    expect(tasks.map((task) => task.kind).sort()).toEqual([
      'add_faq',
      'add_section',
      'meta_rewrite',
      'title_rewrite',
    ])

    // Back on the merchant's list with the recommendation attached, not left
    // in progress.
    const status = await harness.pool.query<{ status: string }>(
      'SELECT status FROM opportunities WHERE id = $1',
      [opportunity.id],
    )
    expect(status.rows[0]?.status).toBe('accepted')
  })

  it('asks once more with the lint failures, and takes the second answer', async () => {
    const opportunity = await optimizeOpportunity()
    const f = fixtures([ungroundedRecommendation(), withProductId(goodRecommendation())])

    const outcome = await generateOptimizeRecommendation(f.deps, {
      accountId,
      opportunityId: opportunity.id,
    })

    expect(outcome.status).toBe('generated')
    if (outcome.status !== 'generated') return
    expect(outcome.attempts).toBe(2)
    expect(f.llm.countOf('optimize_reco')).toBe(2)

    // The re-ask carries the failure it has to fix, and names the address.
    const second = f.llm.requests.filter((request) => request.callType === 'optimize_reco')[1]!
    expect(second.messages[0]!.content).toContain('previous attempt failed these checks')
    expect(second.messages[0]!.content).toContain('product:invented/vegan')
  })

  it('stores a failure and no partial output when the second answer fails too', async () => {
    const opportunity = await optimizeOpportunity()
    const f = fixtures([ungroundedRecommendation(), ungroundedRecommendation()])

    const outcome = await generateOptimizeRecommendation(f.deps, {
      accountId,
      opportunityId: opportunity.id,
    })

    expect(outcome.status).toBe('failed_validation')
    if (outcome.status !== 'failed_validation') return
    expect(outcome.reasons.join(' ')).toContain('product:invented/vegan')
    expect(f.llm.countOf('optimize_reco')).toBe(2)
    // The grader is never asked about something the free checks already refused.
    expect(f.judge.graded).toHaveLength(0)

    const stored = await latestOptimizeRecommendation(db, accountScope(accountId), opportunity.id)
    expect(stored?.state).toBe('failed_validation')
    expect(JSON.stringify(stored?.recommendationJson)).not.toContain('synthetic microfibre')

    const tasks = await listOptimizeTasks(db, accountScope(accountId), opportunity.id)
    expect(tasks).toEqual([])
  })

  it('fails a recommendation the grader marks down on intent, at a score the article gate would pass', async () => {
    const opportunity = await optimizeOpportunity()
    const f = fixtures([withProductId(goodRecommendation())], {
      factualGrounding: 5,
      searchIntentMatch: 3,
    })

    const outcome = await generateOptimizeRecommendation(f.deps, {
      accountId,
      opportunityId: opportunity.id,
    })

    expect(outcome.status).toBe('failed_validation')
    if (outcome.status !== 'failed_validation') return
    expect(outcome.reasons.join(' ')).toContain('searchIntentMatch scored 3')

    const stored = await latestOptimizeRecommendation(db, accountScope(accountId), opportunity.id)
    expect(stored?.state).toBe('failed_validation')
    // The grader's own scores are kept, so a calibration review can read them.
    expect(stored?.judgeScoresJson).toMatchObject({ scores: { searchIntentMatch: 3 } })
  })

  it('supersedes the recommendation it replaces rather than deleting it', async () => {
    const opportunity = await optimizeOpportunity()

    await generateOptimizeRecommendation(fixtures([withProductId(goodRecommendation())]).deps, {
      accountId,
      opportunityId: opportunity.id,
    })
    await harness.pool.query("UPDATE opportunities SET status = 'executing' WHERE id = $1", [
      opportunity.id,
    ])
    await generateOptimizeRecommendation(fixtures([withProductId(goodRecommendation())]).deps, {
      accountId,
      opportunityId: opportunity.id,
    })

    const { rows } = await harness.pool.query<{ state: string; n: string }>(
      'SELECT state::text AS state, count(*)::text AS n FROM optimize_recommendations GROUP BY state ORDER BY state::text',
    )
    expect(rows).toEqual([
      { state: 'superseded', n: '1' },
      { state: 'valid', n: '1' },
    ])
  })

  it('refuses while this store\'s OPTIMIZE calls are paused, and buys nothing', async () => {
    const opportunity = await optimizeOpportunity()
    await tripAccountFlag(db, accountScope(accountId), {
      flag: ACCOUNT_OPTIMIZE_PAUSED_FLAG,
      actor: 'test',
      reason: 'daily allowance spent',
      trippedBy: 'auto',
    })
    const f = fixtures([withProductId(goodRecommendation())])

    const outcome = await generateOptimizeRecommendation(f.deps, {
      accountId,
      opportunityId: opportunity.id,
    })

    expect(outcome.status).toBe('paused')
    expect(f.llm.requests).toHaveLength(0)
    expect(f.seo.billableCalls).toBe(0)
    expect(f.pageFetcher.callCount).toBe(0)
    expect(await statusOf(opportunity.id)).toBe('accepted')
  })

  it('still recommends from the store\'s own facts when no comparison could be made', async () => {
    const opportunity = await optimizeOpportunity()
    const f = fixtures([
      withProductId({
        ...goodRecommendation(),
        sections: [
          {
            heading: 'What they are made of',
            suggested_copy: 'A full-grain leather upper, at 520 g a boot.',
            facts_used: ['product:PRODUCT_ID/material', 'product:PRODUCT_ID/weight'],
            gap_source: 'store',
          },
        ],
        faq: [],
      }),
    ])
    // No results page can be bought and none is held, so the comparison cannot
    // be made — main §14.4 says never decide on stale data, and the store's own
    // facts are not stale.
    const noSerp = { ...f.deps, seo: new MockSeoDataProvider({ serp: {} }) }

    const outcome = await generateOptimizeRecommendation(noSerp, {
      accountId,
      opportunityId: opportunity.id,
    })

    expect(outcome.status).toBe('generated')
    if (outcome.status !== 'generated') return
    expect(outcome.recommendation.sections[0]?.facts_used).toEqual([
      `product:${productId}/material`,
      `product:${productId}/weight`,
    ])
    expect(f.llm.countOf('intent_gap')).toBe(0)
  })
})

/**
 * Every way out of a generation hands the page back.
 *
 * The page is marked "we are working on this" from the moment the merchant
 * presses the button, and for a long time only two endings unmarked it. These
 * cover the ones that did not: the call type switched off, the page gone from
 * the store, and something simply going wrong. Each one used to leave the
 * merchant watching a spinner that never resolved, on a page the button would
 * refuse from then on.
 */
describe.skipIf(!available)('a generation that does not finish', () => {
  it('hands the page back when its page is no longer in the store', async () => {
    const opportunity = await optimizeOpportunity()
    await harness.pool.query('DELETE FROM store_pages WHERE url = $1', [PAGE])
    const f = fixtures([withProductId(goodRecommendation())])

    const outcome = await generateOptimizeRecommendation(f.deps, {
      accountId,
      opportunityId: opportunity.id,
    })

    expect(outcome.status).toBe('skipped')
    if (outcome.status !== 'skipped') return
    expect(outcome.reason).toBe('page_not_in_inventory')
    expect(await statusOf(opportunity.id)).toBe('accepted')
  })

  it('buys nothing for a page Google is not indexing, even once the work has been queued', async () => {
    const opportunity = await optimizeOpportunity()
    await insertMinimalOpportunity(
      db,
      accountScope(accountId),
      {
        signalType: 'indexing_issue',
        entityType: 'url',
        entityRef: PAGE,
        evidenceJson: [{ key: 'reason', value: 'not_indexed', source: 'gsc' }],
        recommendedAction: 'fix',
        status: 'new',
        reasonTemplateKey: 'opportunity.indexing_issue',
        reasonParams: {},
        limitedIntelligence: false,
        rulesVersion: rules().rulesVersion,
      },
      NOW,
    )
    const f = fixtures([withProductId(goodRecommendation())])

    const outcome = await generateOptimizeRecommendation(f.deps, {
      accountId,
      opportunityId: opportunity.id,
    })

    expect(outcome.status).toBe('skipped')
    if (outcome.status !== 'skipped') return
    expect(outcome.reason).toBe('blocked_by_precondition')
    expect(f.llm.requests, 'nothing may be asked of a model for a page that cannot benefit').toEqual([])
    expect(await statusOf(opportunity.id)).toBe('accepted')
  })

  it('leaves one of our own published articles to the rewrite pipeline', async () => {
    await upsertStorePages(db, accountScope(accountId), [
      {
        url: PAGE,
        pageType: 'article_ours',
        handle: 'hiking-boots',
        shopifyId: 'gid://shopify/Article/7',
        title: 'Hiking boots',
        seoTitle: 'Hiking boots',
        seoDescription: null,
        headings: [],
        bodyHtml: '<p>Ours.</p>',
        outboundInternalLinks: [],
        familyIds: [],
        checksum: 'checksum-ours',
      },
    ])
    const opportunity = await optimizeOpportunity()
    const f = fixtures([withProductId(goodRecommendation())])

    const outcome = await generateOptimizeRecommendation(f.deps, {
      accountId,
      opportunityId: opportunity.id,
    })

    expect(outcome.status).toBe('skipped')
    if (outcome.status !== 'skipped') return
    expect(outcome.reason).toBe('our_own_article_goes_to_the_refresh_pool')
    expect(f.llm.requests).toEqual([])
    expect(await statusOf(opportunity.id)).toBe('accepted')
  })

  it('hands the page back when the opportunity is not one this can act on', async () => {
    const opportunity = await optimizeOpportunity()
    await harness.pool.query(
      "UPDATE opportunities SET recommended_action = 'create' WHERE id = $1",
      [opportunity.id],
    )

    const outcome = await generateOptimizeRecommendation(fixtures([]).deps, {
      accountId,
      opportunityId: opportunity.id,
    })

    expect(outcome.status).toBe('skipped')
    expect(await statusOf(opportunity.id)).toBe('accepted')
  })

  it('hands the page back when something throws, and still reports the failure', async () => {
    const opportunity = await optimizeOpportunity()
    // No answer is queued for the recommendation call, so the model client
    // throws part-way through — standing in for any unexpected failure.
    const f = fixtures([])

    await expect(
      generateOptimizeRecommendation(f.deps, { accountId, opportunityId: opportunity.id }),
    ).rejects.toThrow(/no stub answer queued/)

    // The queue may retry, and the merchant may press again. Neither is
    // possible if the page is still marked.
    expect(await statusOf(opportunity.id)).toBe('accepted')
  })

  it('refuses to spend past the day\'s allowance even when the request let it through, and hands the page back', async () => {
    const cap = rules().defaults.budgets.optimize.generations_per_account_per_day
    expect(cap).toBe(2)

    // Two recommendations already written today for this store — the meter the
    // cap reads. The request path checks this too, but several presses can be
    // accepted before any of them has written anything, which is the case this
    // covers.
    for (const suffix of ['a', 'b']) {
      const spent = await insertMinimalOpportunity(
        db,
        accountScope(accountId),
        {
          signalType: 'existing_page_intent_gap',
          entityType: 'url',
          entityRef: `${PAGE}/${suffix}`,
          evidenceJson: [{ key: 'query_cluster', value: QUERY, source: 'gsc' }],
          recommendedAction: 'optimize',
          status: 'accepted',
          reasonTemplateKey: 'opportunity.existing_page_intent_gap',
          reasonParams: {},
          limitedIntelligence: false,
          rulesVersion: rules().rulesVersion,
        },
        NOW,
      )
      await storeOptimizeRecommendation(db, accountScope(accountId), {
        opportunityId: spent.id,
        pageUrl: `${PAGE}/${suffix}`,
        recommendationJson: withProductId(goodRecommendation()),
        judgeScoresJson: null,
        promptVersion: 'optimize-reco.v1',
        modelId: 'claude-sonnet-5',
        rulesVersion: rules().rulesVersion,
        state: 'valid',
      })
    }

    const opportunity = await optimizeOpportunity()
    const f = fixtures([withProductId(goodRecommendation())])

    const outcome = await generateOptimizeRecommendation(f.deps, {
      accountId,
      opportunityId: opportunity.id,
    })

    expect(outcome.status).toBe('paused')
    if (outcome.status !== 'paused') return
    expect(outcome.reason).toBe('daily_cap_reached')
    expect(f.llm.requests).toHaveLength(0)
    expect(f.seo.billableCalls).toBe(0)
    expect(await statusOf(opportunity.id)).toBe('accepted')
  })

  it('does not count a page merely marked as being worked on against the allowance', async () => {
    // Two pages marked and never worked on — under the old count these were
    // the store's whole allowance, spent for ever on nothing.
    for (const suffix of ['a', 'b']) {
      await insertMinimalOpportunity(
        db,
        accountScope(accountId),
        {
          signalType: 'existing_page_intent_gap',
          entityType: 'url',
          entityRef: `${PAGE}/${suffix}`,
          evidenceJson: [{ key: 'query_cluster', value: QUERY, source: 'gsc' }],
          recommendedAction: 'optimize',
          status: 'executing',
          reasonTemplateKey: 'opportunity.existing_page_intent_gap',
          reasonParams: {},
          limitedIntelligence: false,
          rulesVersion: rules().rulesVersion,
        },
        NOW,
      )
    }

    const opportunity = await optimizeOpportunity()
    const f = fixtures([withProductId(goodRecommendation())])

    const outcome = await generateOptimizeRecommendation(f.deps, {
      accountId,
      opportunityId: opportunity.id,
    })

    expect(outcome.status).toBe('generated')
    expect(await statusOf(opportunity.id)).toBe('accepted')
  })
})
