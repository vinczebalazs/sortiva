import { drizzle } from 'drizzle-orm/node-postgres'
import { silentLogger, type LlmClient, type SeoDataProvider } from '@sortiva/core'
import { schema } from '@sortiva/db'
import { loadPrompt, MockLlmClient } from '@sortiva/llm'
import { DRAFT_PROMPT_MAJOR_VERSION } from '../generation/prompts'
import type { PageFetcher } from '@sortiva/providers'
import { runDailyGenerationForAccount } from '../generation/daily-cycle'
import type { ChaosContext, ChaosScenario } from './harness'

/**
 * `T4.6`'s own chaos case, in two halves: kill the daily cycle while it is
 * writing an article, and let the retry arrive **before** the store's local
 * midnight in one, and **after** it in the other.
 *
 * The clock is the whole point, and it is why this is not the same test as
 * `daily-cycle.test.ts`'s same-day crash-and-resume. The cycle deliberately
 * re-reads the store's own clock on every attempt rather than trusting the
 * date the job was queued with, because trusting the queued date is how a job
 * that waited overnight generates yesterday's topic today — the back-filled
 * burst the calendar's gap rule forbids. The unexamined consequence is what
 * the second scenario examines: a retry arriving on the *next* local day looks
 * for that day's work, and whatever the killed attempt left behind on
 * yesterday sits on a date nothing asks about any more.
 *
 * A crash at 23:50 and a retry at 00:05 is ordinary, not exotic: a store whose
 * writing starts in the evening produces one every time a deploy lands late.
 *
 * Convergence here means what it means to a merchant — the day the crash
 * interrupted ends up somewhere terminal, and the article already paid for is
 * either finished or visibly not. A topic left in `generating` with nothing
 * that will ever look at it again is the failure.
 */

const FIRST_DAY = new Date('2026-09-03T07:00:00.000Z')
/** The retry, a whole local day later — the same wall-clock hour, the next date. */
const NEXT_DAY = new Date('2026-09-04T07:00:00.000Z')
const TOPIC_DATE = '2026-09-03'

const FAMILY_ID = '22222222-2222-4222-8222-222222222222'

const seo: SeoDataProvider = {
  keywordMetrics: () => Promise.reject(new Error('not expected to be called')),
  serpTop: async () => ({
    data: [{ position: 1, url: 'https://rival.example/guide', domain: 'rival.example', title: 'Water bottle guide' }],
    meta: { endpoint: 'serp_top', cacheHit: false, billable: true, usdCost: 0.01 },
  }),
  rankedKeywords: () => Promise.reject(new Error('not expected to be called')),
}

const pageFetcher: PageFetcher = {
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

const state = { productId: '', topicId: '' }

/** Every model answer one whole run needs, in the order the pipeline asks for them. */
function enqueueWholeRun(llm: MockLlmClient, productId: string): void {
  llm.enqueue(
    'claim_plan',
    JSON.stringify({
      claims: [
        {
          text: 'For everyday use, the stainless steel bottle is the safer pick.',
          kind: 'recommendation',
          confidence: 'medium',
          evidenceRefs: ['c1'],
          quote: null,
        },
      ],
      gaps: [],
    }),
  )
  llm.enqueue(
    'draft',
    JSON.stringify({
      title: 'Best water bottles: a buying guide',
      metaDescription: 'How to choose a water bottle, by material and capacity.',
      intro:
        'For most kitchens, the stainless steel bottle is the right default[[c1]]. It survives being dropped, it does not hold flavours from yesterday, and it keeps a cold drink cold through an afternoon. Glass suits someone who cares about taste and is careful with a bottle; plastic suits someone for whom weight settles it.',
      sections: [
        {
          heading: 'The decision',
          body: 'Two things decide this: what the bottle is made of, and where it was made[[c1]][[c2]]. Everything else — lid design, colour, finish — follows from those and matters far less in daily use. Work out which of the three materials suits how you actually drink, then narrow down within it.',
        },
        {
          heading: 'Selection criteria: by capacity',
          body: 'Larger sizes suit long days away from a tap, and smaller ones fit a bag and a hand better[[c7]]. If the bottle spends its life on a desk, size is close to irrelevant; if it goes in a rucksack, it decides whether you refill once or three times.',
        },
        {
          heading: 'Recommended types',
          body: 'Steel resists dents and holds temperature well[[c1]]. Glass gives the cleanest taste and is the one to avoid if it will be knocked about. Plastic weighs least of the three, and replacing one costs little when it eventually wears out.',
        },
        {
          heading: 'Common mistakes',
          body: 'The usual one is picking a bottle before checking that the lid seals. The second is buying for a use case you do not have — a vacuum-insulated flask is wasted on someone who refills at a desk twice a day.',
        },
        {
          heading: 'Products',
          body: 'The {{p1}} is a solid all-rounder for someone who has not settled on a preference yet.',
        },
      ],
      faq: [],
      productMentions: [{ id: 'p1', productId, refType: 'recommendation', fields: ['price'] }],
    }),
  )
  const scores = {
    informationGain: 4,
    factualGrounding: 4,
    searchIntentMatch: 3,
    actionability: 3,
    languageQuality: 3,
    ecommerceUsefulness: 3,
  }
  llm.enqueue(
    'judge',
    JSON.stringify({
      scores,
      justifications: Object.fromEntries(Object.keys(scores).map((k) => [k, `graded on ${k}`])),
    }),
  )
}

/**
 * A model client that reaches a checkpoint before every call it serves, so the
 * harness can end the process at any of the three points a real run spends
 * money at.
 */
function checkpointing(inner: MockLlmClient, ctx: ChaosContext): LlmClient {
  return {
    complete: async (request) => {
      ctx.checkpoint(`before:${request.callType}`)
      return inner.complete(request)
    },
  } as LlmClient
}

async function driveOn(ctx: ChaosContext, now: Date): Promise<void> {
  const db = drizzle(ctx.pool, { schema })
  const llm = new MockLlmClient()
  enqueueWholeRun(llm, state.productId)

  await runDailyGenerationForAccount(
    {
      db,
      pool: ctx.pool,
      llm: checkpointing(llm, ctx),
      seo,
      pageFetcher,
      claimPlanPrompt: loadPrompt('claim-plan', 1),
      draftPrompt: loadPrompt('draft', DRAFT_PROMPT_MAJOR_VERSION),
      judgePrompt: loadPrompt('judge', 1),
      contradictionPrompt: loadPrompt('contradiction', 1),
      revisePrompt: loadPrompt('revise', 1),
      now: () => now,
      logger: silentLogger,
    },
    ctx.accountId,
  )
}

/**
 * The control case: the same kill, with the retry arriving before the store's
 * local midnight. This is the one the resume was built for, and it converges —
 * which is what makes the scenario below a finding about the day boundary
 * rather than about crash recovery in general.
 */
export const generationCycleKilledSameDay: ChaosScenario = {
  name: 'generation_cycle_killed_same_day',
  setup: seedSyntheticStore,
  initialCeiling: 3,
  async drive(ctx) {
    await driveOn(ctx, FIRST_DAY)
  },
  async assert(ctx) {
    const finished = await gradedArticles(ctx.pool, ctx.accountId)
    if (finished.articles !== 1) {
      throw new Error(
        `expected exactly one article after the kills; found ${finished.articles} — a retry started a second one`,
      )
    }
    if (finished.gate3Decisions !== 1) {
      throw new Error(
        `the article was written and never graded (${finished.gate3Decisions} Gate 3 decisions): the same-day ` +
          `retry did not finish what the killed attempt started`,
      )
    }
  },
}

/** How far the day actually got: whether an article exists, and whether anything ever graded it. */
async function gradedArticles(
  pool: ChaosContext['pool'],
  accountId: string,
): Promise<{ articles: number; gate3Decisions: number }> {
  const articles = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM articles WHERE account_id = $1',
    [accountId],
  )
  const decisions = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM gate_decisions WHERE account_id = $1 AND gate = 3',
    [accountId],
  )
  return { articles: articles.rows[0]?.n ?? 0, gate3Decisions: decisions.rows[0]?.n ?? 0 }
}

export const generationCycleKilledAcrossMidnight: ChaosScenario = {
  name: 'generation_cycle_killed_across_midnight',

  setup: seedSyntheticStore,

  // Three model calls, so three points a run can die at.
  initialCeiling: 3,

  async drive(ctx) {
    // The first attempt runs on the day the topic is scheduled for. Every
    // attempt after it runs a day later — the retry that arrived after the
    // store's local midnight, which is the case this scenario exists for.
    await driveOn(ctx, ctx.attempt === 0 ? FIRST_DAY : NEXT_DAY)
  },

  async assert(ctx) {
    const { rows } = await ctx.pool.query<{ state: string }>('SELECT state FROM topics WHERE id = $1', [
      state.topicId,
    ])
    const topicState = rows[0]?.state
    if (topicState === undefined) throw new Error('the topic vanished, which no path should be able to do')

    const finished = await gradedArticles(ctx.pool, ctx.accountId)
    if (finished.gate3Decisions === 0) {
      throw new Error(
        `the day never converged. The topic is "${topicState}" with ${finished.articles} article(s) written and ` +
          `none graded: a run killed before the store's local midnight is never picked up again once the retry ` +
          `lands on the next day. Nothing else in the product looks at a topic in this state, so the calendar ` +
          `day is lost, the draft is paid for and never delivered, and the queue records the retry as a success.`,
      )
    }
  },
}

async function seedSyntheticStore(pool: Parameters<NonNullable<ChaosScenario['setup']>>[0], accountId: string) {
  await pool.query('DELETE FROM article_claims WHERE article_id IN (SELECT id FROM articles WHERE account_id = $1)', [accountId])
  await pool.query('DELETE FROM article_product_refs WHERE article_id IN (SELECT id FROM articles WHERE account_id = $1)', [accountId])
  await pool.query('DELETE FROM gate_decisions WHERE account_id = $1', [accountId])
  await pool.query('DELETE FROM articles WHERE account_id = $1', [accountId])
  await pool.query('DELETE FROM topics WHERE account_id = $1', [accountId])
  // The day's ledger key is derived from the topic id, and setup mints a
  // fresh topic every run, so no stale completion record can be mistaken for
  // this one's.

  // A connected store with a confirmed profile: the dequeue checks all have to
  // pass or nothing would be killed in the first place. The *subscription* is
  // seeded by the chaos suite itself rather than here — `subscriptions` has
  // exactly one writer in the product (invariant 16) and a guard test enforces
  // it against every non-test file, which this one is.
  await pool.query(
    `INSERT INTO account_settings (account_id, timezone, draft_review, vacation_mode)
     VALUES ($1, 'UTC', false, false) ON CONFLICT (account_id) DO NOTHING`,
    [accountId],
  )
  await pool.query(
    `INSERT INTO shopify_conns (account_id, shop_handle, access_token, granted_scopes)
     VALUES ($1, 'chaos.myshopify.com', 'cipher', ARRAY['read_products']) ON CONFLICT (account_id) DO NOTHING`,
    [accountId],
  )
  await pool.query(
    `INSERT INTO personas (account_id, description, product_categories, language, country, prompt_version, model_id)
     VALUES ($1, 'A shop selling reusable water bottles.', ARRAY['bottles'], 'en', 'US', 'v1', 'test-model')
     ON CONFLICT (account_id) DO NOTHING`,
    [accountId],
  )

  await pool.query(
    `INSERT INTO product_families (id, account_id, name, differentiation_axes, grouping_source, confidence)
     VALUES ($1, $2, 'Water bottles', ARRAY['capacity'], 'collection', 'high') ON CONFLICT (id) DO NOTHING`,
    [FAMILY_ID, accountId],
  )
  const materials = ['stainless steel', 'glass', 'tritan plastic']
  const origins = ['Germany', 'Portugal', 'Vietnam']
  for (let i = 0; i < 3; i += 1) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO products (account_id, shopify_product_id, title, family_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, shopify_product_id) DO UPDATE SET family_id = EXCLUDED.family_id RETURNING id`,
      [accountId, `chaos-bottle-${i}`, `Bottle ${i}`, FAMILY_ID],
    )
    const productId = rows[0]!.id
    if (i === 0) state.productId = productId
    await pool.query(
      `INSERT INTO product_facts (product_id, facts_json, fact_count, fluff_discarded, prompt_version, model_id)
       VALUES ($1, $2::jsonb, 2, 0, 'v1', 'test-model') ON CONFLICT (product_id) DO NOTHING`,
      [
        productId,
        JSON.stringify({
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
        }),
      ],
    )
  }

  const { rows: opportunityRows } = await pool.query<{ id: string }>(
    `INSERT INTO opportunities (account_id, signal_type, entity_type, entity_ref, evidence_json, impact, impact_score,
                                confidence, reason_template_key, reason_params_json, recommended_action, status,
                                preconditions_json, limited_intelligence, rules_version)
     VALUES ($1, 'uncovered_commercial_query', 'query_cluster', 'chaos-midnight', '[]'::jsonb, 'medium', 50, 50,
             'opportunity.uncovered_commercial_query', '{}'::jsonb, 'create', 'scheduled', '[]'::jsonb, false, 'test')
     ON CONFLICT (account_id, signal_type, entity_ref) WHERE status IN ('new','accepted','scheduled','executing','blocked')
     DO UPDATE SET status = 'scheduled' RETURNING id`,
    [accountId],
  )
  const { rows: topicRows } = await pool.query<{ id: string }>(
    `INSERT INTO topics (account_id, opportunity_id, title, target_keyword, intent_class, family_ids, kind, source,
                         why_line, scheduled_date, state)
     VALUES ($1, $2, 'Best water bottles', 'best water bottles', 'buying_guide', ARRAY[$3::uuid], 'new', 'auto',
             'opportunity.uncovered_commercial_query', $4, 'planned') RETURNING id`,
    [accountId, opportunityRows[0]!.id, FAMILY_ID, TOPIC_DATE],
  )
  state.topicId = topicRows[0]!.id
}
