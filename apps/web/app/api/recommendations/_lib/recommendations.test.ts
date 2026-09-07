import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  RECOMMENDATION_RESPONSE_SCHEMA,
  type OptimizeRecommendation,
  type RecommendationLabels,
} from '@sortiva/core'
import { loadPrompt } from '@sortiva/llm/prompts'
import {
  accountScope,
  insertMinimalOpportunity,
  markStorePagesGoneNotSeenSince,
  markStorePagesSeen,
  storeOptimizeRecommendation,
  upsertStorePages,
  type OpportunityRow,
} from '@sortiva/db'
import {
  TEST_DATABASE_URL,
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import {
  TRUNCATE_QUEUE_SQL,
  installQueueSchema,
  type WorkerUtils,
} from '@sortiva/jobs/runtime/testing'
import { rules } from '@sortiva/rules'
import { withAccount } from '../../auth/_lib/session'
import { OPTIMIZE_RECO_PROMPT_MAJOR_VERSION } from './config'
import {
  makeApplyRecommendationHandler,
  makeDownloadRecommendationHandler,
  makeGenerateRecommendationHandler,
  makeReadRecommendationHandler,
  type RecommendationsDeps,
} from './handlers'

/**
 * T6.2 done-when: "third request in a day returns the cap error; mark-applied
 * schedules an outcome row at +28 d".
 */


/**
 * The prompt and the schema are two halves of one instruction, and nothing
 * makes them agree. The first version of this prompt never mentioned the
 * `rationale` field at all, while the schema refused any answer without it — so
 * the model filled a field nobody had told it what to put in, and whatever came
 * out was shown to the merchant. This holds the version the product actually
 * asks with, not a version named here.
 */
describe('the writing prompt against the answer it demands', () => {
  const prompt = loadPrompt('optimize-reco', OPTIMIZE_RECO_PROMPT_MAJOR_VERSION)

  const demanded = [
    ...RECOMMENDATION_RESPONSE_SCHEMA.required,
    ...RECOMMENDATION_RESPONSE_SCHEMA.properties.title_tag.required,
    ...RECOMMENDATION_RESPONSE_SCHEMA.properties.sections.items.required,
    ...RECOMMENDATION_RESPONSE_SCHEMA.properties.faq.items.required,
  ]

  for (const field of new Set(demanded)) {
    it(`tells the model what belongs in "${field}"`, () => {
      expect(prompt.text).toContain(field)
    })
  }
})

const available = await databaseAvailable()
const NOW = new Date('2026-09-03T10:00:00.000Z')

const labels: RecommendationLabels = {
  documentTitle: 'Page recommendations',
  page: 'Page',
  search: 'Search',
  intentNote: 'What is missing',
  titleTag: 'Title',
  metaDescription: 'Description',
  headings: 'Headings',
  sections: 'Sections',
  faq: 'Questions',
  internalLinks: 'Links',
  linksFrom: 'From',
  linksTo: 'To',
  current: 'Now',
  suggested: 'Suggested',
  basedOn: 'Based on',
  notSet: 'not set',
  headingAdd: 'Add',
  headingRewrite: 'Rewrite',
  trustLine: 'Sortiva does not change your store.',
}

const PAGE_URL = 'https://example-store.com/collections/wide-trail-shoes'

function recommendation(): OptimizeRecommendation {
  return {
    title_tag: { current: 'Wide trail shoes', suggested: 'Wide trail running shoes', rationale: null },
    meta_description: { current: null, suggested: 'Trail shoes in two widths.', rationale: null },
    headings: [],
    sections: [
      {
        heading: 'How to measure your forefoot',
        suggested_copy: 'Stand on paper and mark the widest point of each foot.',
        facts_used: ['subtopic:how to measure forefoot width'],
        gap_source: 'serp',
      },
    ],
    faq: [],
    internal_links: { add_from: [], add_to: [] },
    intent_note: 'The page never says how to check your own width.',
  }
}

describe.skipIf(!available)('/api/recommendations', () => {
  let harness: TestDb
  let accountId: string
  let workerUtils: WorkerUtils

  beforeAll(async () => {
    harness = await setupTestDb('web_recommendations')
    // The queue's tables are installed by the worker, not by our migrations —
    // in production it starts in the same process as the web server before a
    // request can arrive. Nothing starts a worker here, so the suite installs
    // them itself.
    const url = new URL(TEST_DATABASE_URL)
    url.pathname = `/${harness.databaseName}`
    workerUtils = await installQueueSchema(url.toString())
  })

  afterAll(async () => {
    await workerUtils?.release()
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    await harness.pool.query(TRUNCATE_QUEUE_SQL)
    accountId = await insertAccount(harness.pool, 'recommendations@example.com')
    await harness.pool.query(
      'INSERT INTO subscriptions (account_id, stripe_subscription_id, price_id, status) VALUES ($1, $2, $3, $4)',
      [accountId, 'sub_test', 'price_test', 'active'],
    )
    await upsertStorePages(harness.db, accountScope(accountId), [
      {
        url: PAGE_URL,
        pageType: 'collection',
        handle: 'wide-trail-shoes',
        shopifyId: 'gid://shopify/Collection/1',
        title: 'Wide trail shoes',
        seoTitle: 'Wide trail shoes',
        seoDescription: null,
        headings: ['Wide trail shoes'],
        bodyHtml: '<p>Shoes with room across the forefoot.</p>',
        outboundInternalLinks: [],
        familyIds: [],
        checksum: 'checksum-1',
      },
    ])
  })

  function deps(): RecommendationsDeps {
    return { db: harness.db, labels, now: () => NOW }
  }

  const post = (body: unknown, id: string | null = accountId) =>
    withAccount(makeGenerateRecommendationHandler(deps()), async () => id)(
      new Request('http://localhost/api/recommendations', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      undefined,
    )

  const read = (opportunityId: string) =>
    withAccount(makeReadRecommendationHandler(deps()), async () => accountId)(
      new Request(`http://localhost/api/recommendations?opportunityId=${opportunityId}`),
      undefined,
    )

  const apply = (id: string, body: unknown = {}) =>
    withAccount(makeApplyRecommendationHandler(deps()), async () => accountId)(
      new Request(`http://localhost/api/recommendations/${id}/apply`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    )

  const download = (id: string, format: string) =>
    withAccount(makeDownloadRecommendationHandler(deps()), async () => accountId)(
      new Request(`http://localhost/api/recommendations/${id}/download?format=${format}`),
      { params: Promise.resolve({ id }) },
    )

  async function optimizeOpportunity(entityRef = PAGE_URL): Promise<OpportunityRow> {
    return insertMinimalOpportunity(
      harness.db,
      accountScope(accountId),
      {
        signalType: 'existing_page_intent_gap',
        entityType: 'url',
        entityRef,
        evidenceJson: [{ key: 'query_cluster', value: 'trail running shoes for wide feet', source: 'gsc' }],
        recommendedAction: 'optimize',
        status: 'new',
        reasonTemplateKey: 'opportunity.existing_page_intent_gap',
        reasonParams: {},
        limitedIntelligence: false,
        rulesVersion: rules().rulesVersion,
      },
      NOW,
    )
  }

  async function storedRecommendation(opportunityId: string, generatedAt = NOW): Promise<string> {
    const row = await storeOptimizeRecommendation(harness.db, accountScope(accountId), {
      opportunityId,
      pageUrl: PAGE_URL,
      recommendationJson: recommendation(),
      judgeScoresJson: { factualGrounding: 5, searchIntentMatch: 4 },
      promptVersion: 'optimize-reco.v1',
      modelId: 'claude-sonnet-5',
      rulesVersion: rules().rulesVersion,
      state: 'valid',
    })
    if (!row) throw new Error('failed to store the recommendation')
    await harness.pool.query('UPDATE optimize_recommendations SET generated_at = $1 WHERE id = $2', [
      generatedAt.toISOString(),
      row.id,
    ])
    return row.id
  }

  it('queues a generation and moves the opportunity to in-progress', async () => {
    const opportunity = await optimizeOpportunity()

    const response = await post({ opportunityId: opportunity.id })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state: 'generating', generated: true })

    const { rows } = await harness.pool.query<{ identifier: string; payload: unknown }>(
      "SELECT t.identifier, j.payload FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'optimize_recommendation_generate'",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toMatchObject({ accountId, opportunityId: opportunity.id })

    const status = await harness.pool.query<{ status: string }>(
      'SELECT status FROM opportunities WHERE id = $1',
      [opportunity.id],
    )
    expect(status.rows[0]?.status).toBe('executing')
  })

  /**
   * The page is marked as being worked on before the work is queued, so that
   * two tabs pressing at the same instant cannot both start one. If the queue
   * write then fails, the mark has to come off — a page left marked with
   * nothing coming to pick it up shows a spinner that never resolves and
   * refuses every later press.
   */
  it('puts an untouched page back exactly where it was when the queue write fails', async () => {
    const opportunity = await optimizeOpportunity()
    expect(opportunity.status).toBe('new')

    // The queue's own tables, out of reach for the length of one press.
    await harness.pool.query('ALTER SCHEMA graphile_worker RENAME TO graphile_worker_hidden')
    try {
      await expect(post({ opportunityId: opportunity.id })).rejects.toThrow()
    } finally {
      await harness.pool.query('ALTER SCHEMA graphile_worker_hidden RENAME TO graphile_worker')
    }

    const status = await harness.pool.query<{ status: string }>(
      'SELECT status FROM opportunities WHERE id = $1',
      [opportunity.id],
    )
    expect(status.rows[0]?.status).toBe('new')

    // And the merchant can press again, which is the whole point of putting it
    // back rather than leaving it marked.
    expect((await post({ opportunityId: opportunity.id })).status).toBe(200)
  })

  it('returns the cap error on the third request in a day', async () => {
    const cap = rules().defaults.budgets.optimize.generations_per_account_per_day
    expect(cap).toBe(2)

    // Two generations already spent today, each with its recommendation
    // written — the meter the cap reads.
    const first = await optimizeOpportunity(`${PAGE_URL}/a`)
    const second = await optimizeOpportunity(`${PAGE_URL}/b`)
    await storedRecommendation(first.id)
    await storedRecommendation(second.id)

    const third = await optimizeOpportunity(`${PAGE_URL}/c`)
    const response = await post({ opportunityId: third.id })

    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('optimize_daily_cap_reached')
    expect(body.error.message).toContain('available tomorrow')

    const { rows } = await harness.pool.query(
      "SELECT 1 FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'optimize_recommendation_generate'",
    )
    expect(rows).toHaveLength(0)
  })

  it('does not spend the store\'s allowance on presses nothing has picked up', async () => {
    const cap = rules().defaults.budgets.optimize.generations_per_account_per_day
    expect(cap).toBe(2)

    // Two presses, both queued, neither picked up — the exact state a store
    // was in with nothing registered to do the work. Under the old count these
    // two spent the store's whole allowance, and not only for the day.
    const first = await optimizeOpportunity(`${PAGE_URL}/a`)
    const second = await optimizeOpportunity(`${PAGE_URL}/b`)
    expect((await post({ opportunityId: first.id })).status).toBe(200)
    expect((await post({ opportunityId: second.id })).status).toBe(200)

    const marked = await harness.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM opportunities WHERE status = 'executing'",
    )
    expect(marked.rows[0]?.n).toBe('2')

    // A third page is still available to ask about, because nothing has been
    // written and therefore nothing has been spent.
    const third = await optimizeOpportunity(`${PAGE_URL}/c`)
    const response = await post({ opportunityId: third.id })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state: 'generating', generated: true })
  })

  it('answers a second press with "still going" rather than refusing the page for ever', async () => {
    const opportunity = await optimizeOpportunity()

    const firstPress = await post({ opportunityId: opportunity.id })
    expect(await firstPress.json()).toMatchObject({ state: 'generating', generated: true })

    const secondPress = await post({ opportunityId: opportunity.id })
    expect(secondPress.status).toBe(200)
    expect(await secondPress.json()).toMatchObject({ state: 'generating', generated: false })

    // And the second press did not queue the work a second time.
    const { rows } = await harness.pool.query(
      "SELECT 1 FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'optimize_recommendation_generate'",
    )
    expect(rows).toHaveLength(1)

    // The page is still one the merchant can be given back, rather than one
    // the API will refuse from now on.
    const status = await harness.pool.query<{ status: string }>(
      'SELECT status FROM opportunities WHERE id = $1',
      [opportunity.id],
    )
    expect(status.rows[0]?.status).toBe('executing')
  })

  it('hands back a page left marked for longer than a generation can take', async () => {
    const opportunity = await optimizeOpportunity()
    // Plant the stuck row: marked, and nothing has touched it since well
    // before the abandonment interval. This is the state a killed worker or a
    // lost queue row leaves behind, and nothing in the product used to undo it.
    const minutes = rules().defaults.gates.optimize_recommendation.abandoned_after_minutes
    const markedAt = new Date(NOW.getTime() - (minutes + 1) * 60_000)
    await harness.pool.query(
      "UPDATE opportunities SET status = 'executing', updated_at = $1 WHERE id = $2",
      [markedAt.toISOString(), opportunity.id],
    )

    // The drawer stops showing a spinner that would never have resolved.
    const drawer = await read(opportunity.id)
    expect(await drawer.json()).toMatchObject({ recommendation: null })

    // And the button works again, on the same page.
    const response = await post({ opportunityId: opportunity.id })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state: 'generating', generated: true })

    const { rows } = await harness.pool.query(
      "SELECT 1 FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'optimize_recommendation_generate'",
    )
    expect(rows).toHaveLength(1)
  })

  it('leaves a generation that is genuinely still running alone', async () => {
    const opportunity = await optimizeOpportunity()
    const minutes = rules().defaults.gates.optimize_recommendation.abandoned_after_minutes
    const markedAt = new Date(NOW.getTime() - (minutes - 1) * 60_000)
    await harness.pool.query(
      "UPDATE opportunities SET status = 'executing', updated_at = $1 WHERE id = $2",
      [markedAt.toISOString(), opportunity.id],
    )

    const drawer = await read(opportunity.id)
    expect(await drawer.json()).toMatchObject({ recommendation: { state: 'generating' } })

    const status = await harness.pool.query<{ status: string }>(
      'SELECT status FROM opportunities WHERE id = $1',
      [opportunity.id],
    )
    expect(status.rows[0]?.status).toBe('executing')
  })

  it('serves the stored recommendation rather than spending again on unchanged evidence', async () => {
    const opportunity = await optimizeOpportunity()
    const id = await storedRecommendation(opportunity.id)

    const response = await post({ opportunityId: opportunity.id })
    expect(await response.json()).toMatchObject({ state: 'ready', recommendationId: id, generated: false })

    const { rows } = await harness.pool.query(
      "SELECT 1 FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'optimize_recommendation_generate'",
    )
    expect(rows).toHaveLength(0)
  })

  it('regenerates once the scan has moved the evidence on', async () => {
    const opportunity = await optimizeOpportunity()
    await storedRecommendation(opportunity.id, new Date('2026-09-01T10:00:00.000Z'))
    await harness.pool.query('UPDATE opportunities SET updated_at = $1 WHERE id = $2', [
      '2026-09-02T10:00:00.000Z',
      opportunity.id,
    ])

    const response = await post({ opportunityId: opportunity.id })
    expect(await response.json()).toMatchObject({ state: 'generating' })
  })

  it('402s an account with no active subscription', async () => {
    const unpaid = await insertAccount(harness.pool, 'unpaid@example.com')
    const opportunity = await optimizeOpportunity()

    const response = await post({ opportunityId: opportunity.id }, unpaid)
    expect(response.status).toBe(402)
  })

  it('refuses an opportunity that is blocked on something else', async () => {
    const opportunity = await optimizeOpportunity()
    await harness.pool.query("UPDATE opportunities SET status = 'blocked' WHERE id = $1", [opportunity.id])

    const response = await post({ opportunityId: opportunity.id })
    expect(response.status).toBe(409)
  })

  it('schedules the outcome measurement 28 days after mark-applied', async () => {
    const opportunity = await optimizeOpportunity()
    const id = await storedRecommendation(opportunity.id)

    const response = await apply(id)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { appliedAt: string; outcomeDueAt: string }

    const maturityDays = rules().defaults.learning.outcomes.maturity_days
    expect(maturityDays).toBe(28)
    expect(body.outcomeDueAt).toBe('2026-10-01T10:00:00.000Z')

    const { rows } = await harness.pool.query<{ run_at: Date; payload: { opportunityId: string } }>(
      "SELECT j.run_at, j.payload FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'opportunity_outcome_measure'",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload.opportunityId).toBe(opportunity.id)
    expect(new Date(rows[0]!.run_at).toISOString()).toBe('2026-10-01T10:00:00.000Z')

    const opportunityRow = await harness.pool.query<{ status: string; applied_at: Date }>(
      'SELECT status, applied_at FROM opportunities WHERE id = $1',
      [opportunity.id],
    )
    expect(opportunityRow.rows[0]?.status).toBe('completed')
    expect(new Date(opportunityRow.rows[0]!.applied_at).toISOString()).toBe(NOW.toISOString())
  })

  it('marks one task applied without completing the opportunity', async () => {
    const opportunity = await optimizeOpportunity()
    const row = await storeOptimizeRecommendation(
      harness.db,
      accountScope(accountId),
      {
        opportunityId: opportunity.id,
        pageUrl: PAGE_URL,
        recommendationJson: recommendation(),
        judgeScoresJson: null,
        promptVersion: 'optimize-reco.v1',
        modelId: 'claude-sonnet-5',
        rulesVersion: rules().rulesVersion,
        state: 'valid',
      },
      [
        {
          kind: 'title_rewrite',
          description: 'Wide trail running shoes',
          suggestedCopyRef: 'title_tag',
          evidenceRefs: [],
        },
      ],
    )

    const listed = await read(opportunity.id)
    const view = (await listed.json()) as { tasks: { id: string; state: string }[] }
    expect(view.tasks).toHaveLength(1)

    const response = await apply(row!.id, { taskId: view.tasks[0]?.id })
    expect(response.status).toBe(200)

    const status = await harness.pool.query<{ status: string }>(
      'SELECT status FROM opportunities WHERE id = $1',
      [opportunity.id],
    )
    expect(status.rows[0]?.status).toBe('new')
  })

  it('reads back the recommendation and notices the merchant applied the title', async () => {
    const opportunity = await optimizeOpportunity()
    await storedRecommendation(opportunity.id)
    await harness.pool.query('UPDATE store_pages SET seo_title = $1 WHERE url = $2', [
      'Wide trail running shoes',
      PAGE_URL,
    ])

    const response = await read(opportunity.id)
    const body = (await response.json()) as {
      recommendation: { state: string; sections: { heading: string }[] }
      looksApplied: { signals: string[] } | null
    }

    expect(body.recommendation.state).toBe('ready')
    expect(body.recommendation.sections[0]?.heading).toBe('How to measure your forefoot')
    expect(body.looksApplied?.signals).toContain('title_matches_suggestion')
  })

  it('shows a failed generation as one sentence and no partial output', async () => {
    const opportunity = await optimizeOpportunity()
    await storeOptimizeRecommendation(harness.db, accountScope(accountId), {
      opportunityId: opportunity.id,
      pageUrl: PAGE_URL,
      recommendationJson: { failed: true, reasons: ['sections[0]: cites "product:x/y"'] },
      judgeScoresJson: null,
      promptVersion: 'optimize-reco.v1',
      modelId: 'claude-sonnet-5',
      rulesVersion: rules().rulesVersion,
      state: 'failed_validation',
    })

    const response = await read(opportunity.id)
    const body = (await response.json()) as {
      recommendation: { state: string; sections: unknown[]; failureReason: { templateKey: string } }
    }

    expect(body.recommendation.state).toBe('failed_validation')
    expect(body.recommendation.sections).toEqual([])
    expect(body.recommendation.failureReason.templateKey).toBe('optimize.failedValidation.reason')
    expect(JSON.stringify(body)).not.toContain('product:x/y')
  })

  it('downloads the recommendation as Markdown and as HTML', async () => {
    const opportunity = await optimizeOpportunity()
    const id = await storedRecommendation(opportunity.id)

    const markdown = await download(id, 'md')
    expect(markdown.headers.get('content-type')).toContain('text/markdown')
    expect(markdown.headers.get('content-disposition')).toContain('attachment')
    const text = await markdown.text()
    expect(text).toContain('# Page recommendations')
    expect(text).toContain('trail running shoes for wide feet')
    expect(text).toContain('Sortiva does not change your store.')

    const html = await download(id, 'html')
    expect(html.headers.get('content-type')).toContain('text/html')
    expect(await html.text()).toContain('<h1>Page recommendations</h1>')
  })

  /**
   * The listing detection finds a page by reading the store's own catalogue,
   * so it records no search. The download used to print the page's own web
   * address under the heading "Search", which reads as a claim that somebody
   * typed it into Google. It now says nothing about a search unless there is
   * one.
   */
  it('never prints the page\'s own address as the search it competes for', async () => {
    const opportunity = await insertMinimalOpportunity(
      harness.db,
      accountScope(accountId),
      {
        signalType: 'missing_or_weak_metadata',
        entityType: 'url',
        entityRef: PAGE_URL,
        evidenceJson: [{ key: 'missing_fields', value: 'seo_description', source: 'shopify' }],
        recommendedAction: 'optimize',
        status: 'new',
        reasonTemplateKey: 'opportunity.missing_or_weak_metadata',
        reasonParams: {},
        limitedIntelligence: false,
        rulesVersion: rules().rulesVersion,
      },
      NOW,
    )
    const id = await storedRecommendation(opportunity.id)

    const text = await (await download(id, 'md')).text()
    const html = await (await download(id, 'html')).text()

    expect(text).toContain(`**Page:** ${PAGE_URL}`)
    expect(text).not.toContain(`**Search:** ${PAGE_URL}`)
    expect(text).not.toContain('**Search:**')
    expect(html).not.toContain('<strong>Search:</strong>')
  })

  it('will not download another account\'s recommendation', async () => {
    const opportunity = await optimizeOpportunity()
    const id = await storedRecommendation(opportunity.id)
    const other = await insertAccount(harness.pool, 'other@example.com')

    const response = await withAccount(makeDownloadRecommendationHandler(deps()), async () => other)(
      new Request(`http://localhost/api/recommendations/${id}/download?format=md`),
      { params: Promise.resolve({ id }) },
    )

    expect(response.status).toBe(404)
  })

  /**
   * The founder's decision of 2026-09-07: a merchant whose store has no Search
   * Console connection may still be shown a page worth improving — the signal
   * that its Google listing text is missing or duplicated is true either way —
   * but pressing the button can only ever refuse, and it used to refuse in
   * silence. It now refuses with a code of its own, at the press.
   */
  describe('a page whose search we cannot name', () => {
    /** The listing-text detection records no search of its own, by design. */
    async function metadataOpportunity(): Promise<OpportunityRow> {
      return insertMinimalOpportunity(
        harness.db,
        accountScope(accountId),
        {
          signalType: 'missing_or_weak_metadata',
          entityType: 'url',
          entityRef: PAGE_URL,
          evidenceJson: [{ key: 'seo_title', value: 'missing', source: 'store' }],
          recommendedAction: 'optimize',
          status: 'new',
          reasonTemplateKey: 'opportunity.missing_or_weak_metadata',
          reasonParams: {},
          limitedIntelligence: true,
          rulesVersion: rules().rulesVersion,
        },
        NOW,
      )
    }

    it('says so at the press, rather than spinning and coming back unchanged', async () => {
      const opportunity = await metadataOpportunity()

      const response = await post({ opportunityId: opportunity.id })

      expect(response.status).toBe(409)
      const body = (await response.json()) as { error: { code: string } }
      // Its own code, not the nearest existing one: the screen renders its own
      // sentence per code and ignores the message, so reusing another would
      // tell the merchant something untrue.
      expect(body.error.code).toBe('optimize_no_target_query')
    })

    it('spends nothing and leaves the suggestion where it was', async () => {
      const opportunity = await metadataOpportunity()

      await post({ opportunityId: opportunity.id })

      const { rows } = await harness.pool.query(
        "SELECT 1 FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'optimize_recommendation_generate'",
      )
      expect(rows, 'a refusal must not buy anything or spend the day').toHaveLength(0)

      const status = await harness.pool.query<{ status: string }>(
        'SELECT status FROM opportunities WHERE id = $1',
        [opportunity.id],
      )
      // Still offered. The merchant keeps the signal; what they gain is the
      // reason the button cannot act on it yet.
      expect(status.rows[0]?.status).toBe('new')
    })

    it('still acts when the store does have a search for the page', async () => {
      const opportunity = await optimizeOpportunity()

      expect((await post({ opportunityId: opportunity.id })).status).toBe(200)
    })
  })

  /**
   * A merchant presses "improve this page" on a page they have since deleted.
   *
   * The screen was drawn before the page came down, so this is not something
   * the card could have hidden. They are told at the press, while they are
   * looking at the button, rather than watching it spin and come back having
   * changed nothing — and rather than being charged a model call for advice
   * about a page nobody can visit.
   */
  describe('a page the merchant has deleted since the screen was drawn', () => {
    async function deletePage(): Promise<void> {
      // The store served nothing on its last walk, so the one page in this
      // fixture is the one marked deleted.
      await markStorePagesGoneNotSeenSince(
        harness.db,
        accountScope(accountId),
        new Date(Date.now() + 60_000),
      )
    }

    it('is refused at the press, with its own machine-readable reason', async () => {
      const opportunity = await optimizeOpportunity()
      await deletePage()

      const response = await post({ opportunityId: opportunity.id })

      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('optimize_page_gone')
      // 409, like every other refusal on this route, since the integrator
      // promoted the code into the contract's own conflict vocabulary.
      expect(response.status).toBe(409)
    })

    it('enqueues nothing and leaves the suggestion where it was', async () => {
      const opportunity = await optimizeOpportunity()
      await deletePage()

      await post({ opportunityId: opportunity.id })

      const { rows } = await harness.pool.query(
        "SELECT 1 FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'optimize_recommendation_generate'",
      )
      expect(rows, 'a refusal must not spend the day or buy anything').toHaveLength(0)

      const status = await harness.pool.query<{ status: string }>(
        'SELECT status FROM opportunities WHERE id = $1',
        [opportunity.id],
      )
      // Left open rather than blocked: the walk can find the page again, and
      // then the button works with nothing else done.
      expect(status.rows[0]?.status).toBe('new')
    })

    it('works again once the walk finds the page back in the store', async () => {
      const opportunity = await optimizeOpportunity()
      await deletePage()
      await markStorePagesSeen(harness.db, accountScope(accountId), [PAGE_URL], new Date())

      expect((await post({ opportunityId: opportunity.id })).status).toBe(200)
    })
  })

  /**
   * T6.3's own done-when: an open technical obstacle on a collection stops the
   * improve-this-page button on that collection, and says so on the card rather
   * than removing it.
   */
  describe('a page with something wrong with it', () => {
    async function indexingObstacle(entityRef = PAGE_URL): Promise<OpportunityRow> {
      return insertMinimalOpportunity(
        harness.db,
        accountScope(accountId),
        {
          signalType: 'indexing_issue',
          entityType: 'url',
          entityRef,
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
    }

    it('refuses to improve a collection Google is not indexing, and marks the card blocked', async () => {
      const opportunity = await optimizeOpportunity()
      await indexingObstacle()

      const response = await post({ opportunityId: opportunity.id })

      expect(response.status).toBe(409)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('opportunity_not_open')

      const status = await harness.pool.query<{ status: string }>(
        'SELECT status FROM opportunities WHERE id = $1',
        [opportunity.id],
      )
      expect(status.rows[0]?.status).toBe('blocked')

      const { rows } = await harness.pool.query(
        "SELECT 1 FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'optimize_recommendation_generate'",
      )
      expect(rows, 'nothing may be bought for a page that cannot benefit from it').toHaveLength(0)
    })

    it('leaves a different page alone', async () => {
      const opportunity = await optimizeOpportunity()
      await indexingObstacle('https://example-store.com/collections/road-shoes')

      expect((await post({ opportunityId: opportunity.id })).status).toBe(200)
    })

    it('does not treat the store competing with itself as an obstacle', async () => {
      const opportunity = await optimizeOpportunity()
      await insertMinimalOpportunity(
        harness.db,
        accountScope(accountId),
        {
          signalType: 'cannibalization',
          entityType: 'url',
          entityRef: PAGE_URL,
          evidenceJson: [],
          recommendedAction: 'fix',
          status: 'new',
          reasonTemplateKey: 'opportunity.cannibalization',
          reasonParams: {},
          limitedIntelligence: false,
          rulesVersion: rules().rulesVersion,
        },
        NOW,
      )

      expect((await post({ opportunityId: opportunity.id })).status).toBe(200)
    })
  })

  describe('an article we published for this store', () => {
    const OUR_ARTICLE = 'https://example-store.com/blogs/news/choosing-wide-trail-shoes'

    beforeEach(async () => {
      await upsertStorePages(harness.db, accountScope(accountId), [
        {
          url: OUR_ARTICLE,
          pageType: 'article_ours',
          handle: 'choosing-wide-trail-shoes',
          shopifyId: 'gid://shopify/Article/9',
          title: 'Choosing wide trail shoes',
          seoTitle: 'Choosing wide trail shoes',
          seoDescription: null,
          headings: ['Choosing wide trail shoes'],
          bodyHtml: '<p>Ours.</p>',
          outboundInternalLinks: [],
          familyIds: [],
          checksum: 'checksum-ours',
        },
      ])
    })

    it('is never handed back as a list of edits', async () => {
      const opportunity = await optimizeOpportunity(OUR_ARTICLE)

      const response = await post({ opportunityId: opportunity.id })

      expect(response.status).toBe(409)
      expect((await response.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'opportunity_not_open' },
      })

      const status = await harness.pool.query<{ status: string }>(
        'SELECT status FROM opportunities WHERE id = $1',
        [opportunity.id],
      )
      expect(status.rows[0]?.status, 'the press must not have spent the row').toBe('new')
    })
  })

  describe('the FIX recommendation the drawer reads', () => {
    /** Two of the store's own pages splitting one search between them. */
    async function cannibalizationOpportunity(): Promise<OpportunityRow> {
      return insertMinimalOpportunity(
        harness.db,
        accountScope(accountId),
        {
          signalType: 'cannibalization',
          entityType: 'query_cluster',
          entityRef: 'trail running shoes',
          evidenceJson: [
            { key: 'query_cluster', value: 'trail running shoes', source: 'gsc' },
            { key: 'competing_page_1', value: PAGE_URL, source: 'gsc' },
            { key: 'competing_page_1_impression_share', value: 0.45, source: 'gsc' },
            { key: 'competing_page_1_position', value: 8.2, source: 'gsc' },
            { key: 'competing_page_1_type', value: 'collection', source: 'content_inventory' },
            {
              key: 'competing_page_2',
              value: 'https://example-store.com/products/trail-1',
              source: 'gsc',
            },
            { key: 'competing_page_2_impression_share', value: 0.3, source: 'gsc' },
            { key: 'competing_page_2_position', value: 12.4, source: 'gsc' },
            { key: 'competing_page_2_type', value: 'product', source: 'content_inventory' },
          ],
          recommendedAction: 'fix',
          status: 'new',
          reasonTemplateKey: 'opportunity.cannibalization',
          reasonParams: {},
          limitedIntelligence: false,
          rulesVersion: rules().rulesVersion,
        },
        NOW,
      )
    }

    it('names the primary page, the links to move and where a canonical would be wrong', async () => {
      await upsertStorePages(harness.db, accountScope(accountId), [
        {
          url: 'https://example-store.com/pages/shoe-guide',
          pageType: 'page',
          handle: 'shoe-guide',
          shopifyId: 'gid://shopify/Page/3',
          title: 'Shoe guide',
          seoTitle: null,
          seoDescription: null,
          headings: [],
          bodyHtml: '<p>Guide.</p>',
          outboundInternalLinks: ['https://example-store.com/products/trail-1'],
          familyIds: [],
          checksum: 'checksum-guide',
        },
      ])
      const fix = await cannibalizationOpportunity()

      const body = (await (await read(fix.id)).json()) as {
        recommendation: null
        fix: {
          sections: { kind: string; lines: { templateKey: string; params: Record<string, unknown> }[] }[]
          trustLineKey: string
        }
      }

      expect(body.recommendation).toBeNull()
      expect(body.fix.trustLineKey).toBe('fix.trustLine')

      const [primary, links, canonical] = body.fix.sections
      expect(primary?.lines[0]?.params.url).toBe(PAGE_URL)
      expect(links?.lines[0]?.params).toMatchObject({
        fromUrl: 'https://example-store.com/pages/shoe-guide',
        currentTarget: 'https://example-store.com/products/trail-1',
        suggestedTarget: PAGE_URL,
      })
      expect(canonical?.lines.map((line) => line.templateKey)).toEqual([
        'fix.consolidation.canonical.notAdvised',
      ])
    })

    it('never asks the merchant to go and edit a page they have deleted', async () => {
      await upsertStorePages(harness.db, accountScope(accountId), [
        {
          url: 'https://example-store.com/pages/shoe-guide',
          pageType: 'page',
          handle: 'shoe-guide',
          shopifyId: 'gid://shopify/Page/3',
          title: 'Shoe guide',
          seoTitle: null,
          seoDescription: null,
          headings: [],
          bodyHtml: '<p>Guide.</p>',
          outboundInternalLinks: ['https://example-store.com/products/trail-1'],
          familyIds: [],
          checksum: 'checksum-guide',
        },
      ])
      // The store still serves the collection and no longer serves the guide.
      // The guide holding the link is the only difference from the test above.
      const walk = new Date(Date.now() + 60_000)
      await markStorePagesSeen(harness.db, accountScope(accountId), [PAGE_URL], walk)
      await markStorePagesGoneNotSeenSince(harness.db, accountScope(accountId), walk)
      const fix = await cannibalizationOpportunity()

      const body = (await (await read(fix.id)).json()) as {
        fix: {
          sections: { kind: string; lines: { templateKey: string; params: Record<string, unknown> }[] }[]
        }
      }

      const lines = body.fix.sections.flatMap((section) => section.lines)
      // The recommendation is still made — the pages it is about are still
      // there — and only the instruction to edit a deleted page is gone.
      expect(lines.some((line) => line.params.url === PAGE_URL)).toBe(true)
      expect(
        lines.map((line) => line.params.fromUrl).filter(Boolean),
        'a link to move can only be moved on a page that still exists',
      ).toEqual([])
    })
  })
})
