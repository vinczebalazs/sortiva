import { drizzle } from 'drizzle-orm/node-postgres'
import { publishMarker, silentLogger, staticShopifyAuth } from '@sortiva/core'
import { schema } from '@sortiva/db'
import { FakeShopifyPublishClient } from '@sortiva/providers'
import { rules } from '@sortiva/rules'
import { publishArticleToShopify } from '../publish/auto-publish'
import { sweepPublishRecovery } from '../publish/recovery'
import type { ChaosContext, ChaosScenario } from './harness'

/**
 * `T5.2`'s own chaos case, and the one main §14.3.9 names outright: kill the
 * worker between posting an article to a merchant's shop and recording that it
 * did, then assert that exactly one article is on the shop when everything has
 * settled.
 *
 * This is the only place in the product where a crash can cost a merchant
 * something that cannot be taken back. Every other interrupted step is either a
 * read, which can be repeated, or a purchase, which is cached. A blog post that
 * goes out twice is two posts on somebody else's site, in their name, that they
 * have to find and delete.
 *
 * The fake shop is the point rather than a limitation. It counts what was
 * created, so "exactly one" is a measurement rather than an inspection — and it
 * survives the kills, which a real store could not be made to do reproducibly.
 *
 * What converges here: the claim ends `confirmed`, the article ends `published`
 * with the address the shop gave it, and `createArticle` was called exactly
 * once however many times the worker died.
 */

const NOW = new Date('2026-09-03T09:00:00.000Z')
const TOPIC_DATE = '2026-09-03'

/**
 * The shop outlives the kills, because a real one does. A worker restarting
 * finds the merchant's blog exactly as its predecessor left it — including the
 * article it posted and never got to write down.
 */
const shop = new FakeShopifyPublishClient()
const state = { articleId: '', productId: '' }

/**
 * How the scenario reaches the fake shop. Static rather than renewing: what is
 * under test here is what a crash does to a publication, and a token that
 * renewed itself mid-scenario would be a second moving part in a test about one.
 */
const authFor = async () => staticShopifyAuth('chaos-store', 'shpat_chaos')

function deps(ctx: ChaosContext, now: Date) {
  return {
    db: drizzle(ctx.pool, { schema }),
    pool: ctx.pool,
    shopify: shop,
    authFor,
    logger: silentLogger,
    now: () => now,
    /**
     * Only one point is offered to the harness, and it is the one the scenario
     * is named after: the article is on the merchant's shop and nothing of ours
     * records it. Offering the earlier point too would let the seeded draw land
     * on a kill before anything had been posted — which converges for a
     * different and much less interesting reason, and would leave the dangerous
     * instant untested on the run that happened to draw it.
     */
    checkpoint: (label: string) => {
      if (label === 'publish:executed') ctx.checkpoint(label)
    },
  }
}

export const publishKilledBetweenExecuteAndConfirm: ChaosScenario = {
  name: 'publish_killed_between_execute_and_confirm',

  setup: seedPublishableStore,

  // One point, so every kill lands at the dangerous instant.
  initialCeiling: 1,

  async drive(ctx) {
    // Every attempt after the first is a worker that started up again. It runs
    // the publish-hour path exactly as the dead one did, and then the recovery
    // sweep runs — which is what a live process does every five minutes.
    await publishArticleToShopify(deps(ctx, NOW), {
      accountId: ctx.accountId,
      articleId: state.articleId,
    })

    // The sweep sees a claim old enough to be considered interrupted. Its
    // clock is moved forward rather than the claim's timestamp being written
    // backwards, so nothing under test is being adjusted to make it pass.
    const later = new Date(Date.now() + 30 * 60 * 1000)
    await sweepPublishRecovery({ ...deps(ctx, later), checkpoint: undefined })
  },

  async assert(ctx) {
    const marker = publishMarker(state.articleId)
    const posted = shop.countByMarker(marker)
    if (posted !== 1) {
      throw new Error(
        `expected exactly one article on the shop carrying ${marker}; found ${posted}. ` +
          `A kill between posting and recording it has produced a duplicate post on a merchant's own site.`,
      )
    }

    const creates = shop.calls.filter((call) => call.op === 'create').length
    if (creates !== 1) {
      throw new Error(
        `the shop was asked to create an article ${creates} times. Even where the second create failed, ` +
          `a re-send that was not preceded by asking the shop whether the post was already there is the ` +
          `bug this protocol exists to prevent.`,
      )
    }

    const { rows: intents } = await ctx.pool.query<{ state: string; shopify_article_id: string | null }>(
      'SELECT state, shopify_article_id FROM publish_intents WHERE account_id = $1',
      [ctx.accountId],
    )
    if (intents.length !== 1) {
      throw new Error(`expected one publication claim; found ${intents.length}`)
    }
    if (intents[0]!.state !== 'confirmed' || !intents[0]!.shopify_article_id) {
      throw new Error(
        `the claim ended "${intents[0]!.state}" with remote id ${intents[0]!.shopify_article_id}: ` +
          `the post is on the merchant's shop and nothing of ours records which article it is.`,
      )
    }

    const { rows: articles } = await ctx.pool.query<{ state: string; delivery: string; published_url: string | null }>(
      'SELECT state, delivery, published_url FROM articles WHERE id = $1',
      [state.articleId],
    )
    const article = articles[0]
    if (!article) throw new Error('the article vanished, which no path should be able to do')
    if (article.state !== 'published' || article.delivery !== 'auto') {
      throw new Error(
        `the article ended "${article.state}"/"${article.delivery}": it is on the merchant's shop and the ` +
          `app still shows it as waiting to go out.`,
      )
    }
    if (!article.published_url) {
      throw new Error('the article was published with no address, so nothing can attribute its traffic')
    }

    // The brake that stops publishing when a shop starts refusing counts these
    // rows. A kill lands after the shop has answered and before the claim is
    // confirmed, so the row has to be written on the near side of that instant:
    // one attempt was really made, and the restarts and the sweep that follow
    // must not add a second or leave it with none.
    const { rows: recorded } = await ctx.pool.query<{ outcome: string; failure_class: string | null }>(
      'SELECT outcome, failure_class FROM publish_attempts WHERE account_id = $1',
      [ctx.accountId],
    )
    if (recorded.length !== 1 || recorded[0]!.outcome !== 'succeeded' || recorded[0]!.failure_class !== null) {
      throw new Error(
        `expected one recorded publish attempt that succeeded; found ${JSON.stringify(recorded)}. ` +
          `The count the publishing brake reads is wrong for a run that posted exactly one article.`,
      )
    }
  },
}

async function seedPublishableStore(
  pool: Parameters<NonNullable<ChaosScenario['setup']>>[0],
  accountId: string,
): Promise<void> {
  shop.articles.clear()
  shop.calls.length = 0

  await pool.query('DELETE FROM publish_attempts WHERE account_id = $1', [accountId])
  await pool.query('DELETE FROM publish_intents WHERE account_id = $1', [accountId])
  await pool.query(
    'DELETE FROM article_product_refs WHERE article_id IN (SELECT id FROM articles WHERE account_id = $1)',
    [accountId],
  )
  await pool.query('DELETE FROM articles WHERE account_id = $1', [accountId])
  await pool.query('DELETE FROM gate_decisions WHERE account_id = $1', [accountId])
  await pool.query('DELETE FROM topics WHERE account_id = $1', [accountId])

  // A store that has granted posting permission and named a blog. Without both
  // the publish refuses before it reaches anything a kill could interrupt.
  await pool.query(
    `INSERT INTO account_settings (account_id, timezone, publish_hour, delivery)
     VALUES ($1, 'UTC', 9, 'auto')
     ON CONFLICT (account_id) DO UPDATE SET delivery = 'auto'`,
    [accountId],
  )
  await pool.query(
    `INSERT INTO shopify_conns (account_id, shop_handle, access_token, granted_scopes, target_blog_id, target_blog_handle)
     VALUES ($1, 'chaos-publish', 'enc:token', ARRAY['read_products','read_content','write_content'], 'blog-1', 'news')
     ON CONFLICT (account_id) DO UPDATE SET
       granted_scopes = EXCLUDED.granted_scopes,
       target_blog_id = EXCLUDED.target_blog_id,
       target_blog_handle = EXCLUDED.target_blog_handle`,
    [accountId],
  )

  const { rows: productRows } = await pool.query<{ id: string }>(
    `INSERT INTO products (account_id, shopify_product_id, title, variants, price_range)
     VALUES ($1, 'chaos-publish-1', 'Steel bottle', $2::jsonb, $3::jsonb)
     ON CONFLICT (account_id, shopify_product_id) DO UPDATE SET title = EXCLUDED.title
     RETURNING id`,
    [
      accountId,
      JSON.stringify([{ price: 49.99, available: true, compareAtPrice: null }]),
      JSON.stringify({ min: 49.99, max: 49.99, currency: 'USD' }),
    ],
  )
  state.productId = productRows[0]!.id

  const { rows: opportunityRows } = await pool.query<{ id: string }>(
    `INSERT INTO opportunities (account_id, signal_type, entity_type, entity_ref, evidence_json, impact, impact_score,
                                confidence, reason_template_key, reason_params_json, recommended_action, status,
                                preconditions_json, limited_intelligence, rules_version)
     VALUES ($1, 'uncovered_commercial_query', 'query_cluster', 'chaos-publish', '[]'::jsonb, 'medium', 50, 50,
             'opportunity.uncovered_commercial_query', '{}'::jsonb, 'create', 'scheduled', '[]'::jsonb, false, 'test')
     ON CONFLICT (account_id, signal_type, entity_ref) WHERE status IN ('new','accepted','scheduled','executing','blocked')
     DO UPDATE SET status = 'scheduled' RETURNING id`,
    [accountId],
  )
  const { rows: topicRows } = await pool.query<{ id: string }>(
    `INSERT INTO topics (account_id, opportunity_id, title, target_keyword, intent_class, kind, source,
                         why_line, scheduled_date, state)
     VALUES ($1, $2, 'Best bottles', 'best bottles', 'buying_guide', 'new', 'auto',
             'opportunity.uncovered_commercial_query', $3, 'generating') RETURNING id`,
    [accountId, opportunityRows[0]!.id, TOPIC_DATE],
  )
  const topicId = topicRows[0]!.id
  await pool.query(
    `INSERT INTO gate_decisions (account_id, topic_id, gate, outcome, scores_json, rules_version)
     VALUES ($1, $2, 3, 'passed', '{}'::jsonb, $3)`,
    // The real version string, not a placeholder: these scenarios kill the
    // process mid-publish and assert the store converges, and a verdict that
    // could not say which thresholds produced it is a verdict the recovery
    // path should never have to reason about.
    [accountId, topicId, rules().rulesVersion],
  )

  const { rows: articleRows } = await pool.query<{ id: string }>(
    `INSERT INTO articles (account_id, topic_id, title, slug, target_keyword, state, meta_description, body_json)
     VALUES ($1, $2, 'Best bottles', $3, 'best bottles', 'draft', 'How to choose a bottle.', $4::jsonb)
     RETURNING id`,
    [
      accountId,
      topicId,
      `best-bottles-${Date.now()}`,
      JSON.stringify({ intro: 'The {{p1}} is the one to buy.', sections: [], faq: [] }),
    ],
  )
  state.articleId = articleRows[0]!.id

  await pool.query(
    `INSERT INTO article_product_refs (article_id, product_id, ref_type, placeholder_key, fields_rendered)
     VALUES ($1, $2, 'recommendation', 'p1', ARRAY['price']::product_ref_field[])`,
    [state.articleId, state.productId],
  )
}
