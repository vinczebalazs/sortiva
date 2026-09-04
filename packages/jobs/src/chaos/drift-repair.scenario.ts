import { drizzle } from 'drizzle-orm/node-postgres'
import { publishMarker, silentLogger, type LlmClient, type SeoDataProvider } from '@sortiva/core'
import { schema } from '@sortiva/db'
import { loadPrompt, MockLlmClient } from '@sortiva/llm'
import { FakeShopifyPublishClient, type PageFetcher } from '@sortiva/providers'
import { runDailyGenerationForAccount } from '../generation/daily-cycle'
import { runExportDeliveryForAccount } from '../publish/deliver'
import { runDriftPassForAccount } from '../drift/sweep'
import type { ChaosContext, ChaosScenario } from './harness'

/**
 * `T5.3`'s own chaos case, and the only one that runs the whole product end to
 * end: a store is read, the day's article is written and graded, it is posted
 * to the merchant's blog, the merchant then withdraws the product it
 * recommends, and the article is mended and re-posted.
 *
 * The point is the last two steps, and specifically the instant between them.
 * Mending the article means pointing its product mention at a different
 * product — and the moment that is done, nothing about current state can tell
 * that a repair was ever needed. A worker dying right there would leave a
 * corrected copy in the app, a stale article on somebody's blog, and no way for
 * any later pass to notice the difference. That is the failure this scenario
 * exists to make impossible, and it is not a failure any of the other eight
 * scenarios can reach.
 *
 * What must be true however many times the worker is killed: one article, one
 * post on the shop, one repair, and the post on the shop naming the product the
 * store still sells.
 */

const NOW = new Date('2026-09-20T09:00:00.000Z')
const TOPIC_DATE = '2026-09-20'
const FAMILY_ID = '33333333-3333-4333-8333-333333333333'

/** The shop outlives the kills, because a real one does. */
const shop = new FakeShopifyPublishClient()
const state = { goneProductId: '', standInProductId: '', topicId: '' }

const cipher = { decrypt: (value: string) => value.replace(/^enc:/, '') }

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

function checkpointing(inner: MockLlmClient, ctx: ChaosContext): LlmClient {
  return {
    complete: async (request) => {
      ctx.checkpoint(`before:${request.callType}`)
      return inner.complete(request)
    },
  } as LlmClient
}

export const driftRepairAcrossPublish: ChaosScenario = {
  name: 'drift_repair_across_publish',

  setup: seedStoreWithAWithdrawnProduct,

  // Three model calls, the mend, and the re-post. The first posting offers no
  // kill point here on purpose: the scenario that exists for that instant
  // already covers it, and offering it again would spend this scenario's kill
  // budget on a case that is tested better elsewhere.
  initialCeiling: 5,

  async drive(ctx) {
    const db = drizzle(ctx.pool, { schema })
    const llm = new MockLlmClient()
    enqueueWholeRun(llm, state.goneProductId)

    // Write and grade the day's article.
    await runDailyGenerationForAccount(
      {
        db,
        pool: ctx.pool,
        llm: checkpointing(llm, ctx),
        seo,
        pageFetcher,
        claimPlanPrompt: loadPrompt('claim-plan', 1),
        draftPrompt: loadPrompt('draft', 1),
        judgePrompt: loadPrompt('judge', 1),
        contradictionPrompt: loadPrompt('contradiction', 1),
        revisePrompt: loadPrompt('revise', 1),
        now: () => NOW,
        logger: silentLogger,
      },
      ctx.accountId,
    )

    // Hand it over at the publish hour — which, for this store, means posting
    // it to their blog.
    await runExportDeliveryForAccount(
      {
        db,
        pool: ctx.pool,
        shopify: shop,
        cipher,
        now: () => NOW,
        logger: silentLogger,
      },
      { accountId: ctx.accountId, date: TOPIC_DATE },
    )

    // The merchant withdrew the product it recommends. Notice, mend, re-post.
    await runDriftPassForAccount(
      {
        db,
        pool: ctx.pool,
        shopify: shop,
        cipher,
        now: () => NOW,
        logger: silentLogger,
        checkpoint: (label: string) => {
          if (label === 'repair:mended' || label === 'republish:executed') ctx.checkpoint(label)
        },
      },
      { accountId: ctx.accountId },
    )
  },

  async assert(ctx) {
    const { rows: articles } = await ctx.pool.query<{ id: string; state: string }>(
      'SELECT id, state FROM articles WHERE account_id = $1',
      [ctx.accountId],
    )
    if (articles.length !== 1) {
      throw new Error(
        `expected exactly one article after the kills; found ${articles.length} — a retry started a second one`,
      )
    }
    const articleId = articles[0]!.id

    const marker = publishMarker(articleId)
    const posted = shop.countByMarker(marker)
    if (posted !== 1) {
      throw new Error(
        `expected exactly one article on the shop carrying ${marker}; found ${posted}. A kill somewhere between ` +
          `writing, posting and repairing has produced a duplicate post on a merchant's own site.`,
      )
    }
    const creates = shop.calls.filter((call) => call.op === 'create').length
    if (creates !== 1) {
      throw new Error(`the shop was asked to create an article ${creates} times; the repair must update, never create`)
    }

    const { rows: refs } = await ctx.pool.query<{ product_id: string | null }>(
      'SELECT product_id FROM article_product_refs WHERE article_id = $1',
      [articleId],
    )
    if (refs.length !== 1 || refs[0]!.product_id !== state.standInProductId) {
      throw new Error(
        `the article still recommends the withdrawn product (${refs[0]?.product_id}). The mend either never ran ` +
          `or was undone by a retry.`,
      )
    }

    const { rows: repairs } = await ctx.pool.query<{ status: string; outcome_json: unknown }>(
      `SELECT status, outcome_json FROM opportunities
        WHERE account_id = $1 AND entity_type = 'article' AND entity_ref = $2
          AND signal_type IN ('broken_product_reference', 'product_change_impact')`,
      [ctx.accountId, articleId],
    )
    if (repairs.length !== 1) {
      throw new Error(`expected one repair record; found ${repairs.length}`)
    }
    if (repairs[0]!.status !== 'completed') {
      throw new Error(
        `the repair ended "${repairs[0]!.status}": the article in the app is mended and the one on the merchant's ` +
          `blog still names a product they withdrew, with nothing left that will ever notice.`,
      )
    }

    const remoteId = (
      await ctx.pool.query<{ shopify_article_id: string | null }>(
        `SELECT shopify_article_id FROM publish_intents
          WHERE account_id = $1 AND article_external_id = $2 AND state = 'confirmed'`,
        [ctx.accountId, marker],
      )
    ).rows[0]?.shopify_article_id
    const body = remoteId ? shop.articles.get(remoteId)?.bodyHtml : undefined
    if (!body || !body.includes('Bottle 1')) {
      throw new Error(
        `the article on the merchant's shop does not name the replacement product. The repair was recorded as ` +
          `done and the page a reader sees was never corrected.`,
      )
    }
  },
}

async function seedStoreWithAWithdrawnProduct(
  pool: Parameters<NonNullable<ChaosScenario['setup']>>[0],
  accountId: string,
): Promise<void> {
  shop.articles.clear()
  shop.calls.length = 0

  await pool.query('DELETE FROM publish_intents WHERE account_id = $1', [accountId])
  await pool.query('DELETE FROM article_claims WHERE article_id IN (SELECT id FROM articles WHERE account_id = $1)', [accountId])
  await pool.query('DELETE FROM article_product_refs WHERE article_id IN (SELECT id FROM articles WHERE account_id = $1)', [accountId])
  await pool.query('DELETE FROM gate_decisions WHERE account_id = $1', [accountId])
  await pool.query('DELETE FROM articles WHERE account_id = $1', [accountId])
  await pool.query('DELETE FROM topics WHERE account_id = $1', [accountId])
  await pool.query('DELETE FROM opportunity_tasks WHERE opportunity_id IN (SELECT id FROM opportunities WHERE account_id = $1)', [accountId])
  await pool.query('DELETE FROM opportunities WHERE account_id = $1', [accountId])
  await pool.query(
    `DELETE FROM webhook_events WHERE topic LIKE 'catalog_change/%' AND payload ->> 'account_id' = $1`,
    [accountId],
  )

  // A store that granted posting permission and named a blog, so the day's
  // article really goes out rather than becoming a download.
  await pool.query(
    `INSERT INTO account_settings (account_id, timezone, publish_hour, draft_review, vacation_mode, delivery, auto_repair)
     VALUES ($1, 'UTC', 9, false, false, 'auto', true)
     ON CONFLICT (account_id) DO UPDATE SET delivery = 'auto', auto_repair = true, draft_review = false`,
    [accountId],
  )
  await pool.query(
    `INSERT INTO shopify_conns (account_id, shop_handle, access_token, granted_scopes, target_blog_id, target_blog_handle)
     VALUES ($1, 'chaos-drift', 'enc:token', ARRAY['read_products','read_content','write_content'], 'blog-1', 'news')
     ON CONFLICT (account_id) DO UPDATE SET
       shop_handle = EXCLUDED.shop_handle,
       granted_scopes = EXCLUDED.granted_scopes,
       target_blog_id = EXCLUDED.target_blog_id,
       target_blog_handle = EXCLUDED.target_blog_handle`,
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
      `INSERT INTO products (account_id, shopify_product_id, title, family_id, variants, price_range)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       ON CONFLICT (account_id, shopify_product_id)
       DO UPDATE SET family_id = EXCLUDED.family_id, variants = EXCLUDED.variants RETURNING id`,
      [
        accountId,
        `chaos-drift-bottle-${i}`,
        `Bottle ${i}`,
        FAMILY_ID,
        JSON.stringify([{ price: 20 + i, available: true, compareAtPrice: null }]),
        JSON.stringify({ min: 20 + i, max: 20 + i, currency: 'USD' }),
      ],
    )
    const productId = rows[0]!.id
    if (i === 0) state.goneProductId = productId
    if (i === 1) state.standInProductId = productId
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
     VALUES ($1, 'uncovered_commercial_query', 'query_cluster', 'chaos-drift', '[]'::jsonb, 'medium', 50, 50,
             'opportunity.uncovered_commercial_query', '{}'::jsonb, 'create', 'scheduled', '[]'::jsonb, false, 'test')
     RETURNING id`,
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

  // The merchant withdraws the product the article is about to recommend. The
  // change is written down the way the webhook handler writes it; nothing
  // deletes the local row, so this entry is the only evidence it went.
  await pool.query(
    `INSERT INTO webhook_events (webhook_id, source, topic, payload, status, received_at, processed_at)
     VALUES ($1, 'shopify', 'catalog_change/product_deleted', $2::jsonb, 'processed', $3, $3)
     ON CONFLICT (webhook_id) DO NOTHING`,
    [
      `catalog_change/${accountId}:product_deleted:chaos-drift-bottle-0:${NOW.toISOString()}`,
      JSON.stringify({
        account_id: accountId,
        shop_handle: 'chaos-drift',
        kind: 'product_deleted',
        entity_id: 'chaos-drift-bottle-0',
        occurred_at: NOW.toISOString(),
        changed_fields: [],
      }),
      NOW,
    ],
  )
}
