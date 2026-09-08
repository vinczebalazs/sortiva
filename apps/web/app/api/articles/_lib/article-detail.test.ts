import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { articleDetailResponseSchema } from '@sortiva/core'
import {
  accountScope,
  insertArticleProductRefs,
  insertGateDecision,
  markArticleOverridden,
  markArticleRejectedByGate,
  saveDraftBody,
  upsertProducts,
  productIdsByShopifyId,
} from '@sortiva/db'
import { databaseAvailable, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
// Deep import, not the `@sortiva/jobs` barrel — the same chain `override.ts`
// avoids. The override is driven through the code that really writes it, so a
// hand-built audit row cannot hide what the page does with a real one.
import { publishAnyway } from '@sortiva/jobs/generation/override-article'
import { withAccount } from '../../auth/_lib/session'
import { makeGetArticleHandler } from './library'

/**
 * The article page, driven end to end: the real session wrapper, the real
 * handler, the real repositories, a real Postgres.
 *
 * The page used to render from fixtures because nothing served this address.
 * Mocking the fetch here would reproduce exactly that, so nothing is mocked.
 */

describe('the route exists where the screen calls it', () => {
  it('serves GET /api/articles/{articleId}', async () => {
    const route = await import('../[articleId]/route')
    expect(typeof route.GET).toBe('function')
    expect(route.dynamic).toBe('force-dynamic')
  })
})

const available = await databaseAvailable()

describe.skipIf(!available)('reading one article', () => {
  let harness: TestDb
  let mine: string
  let theirs: string
  let topicId: string
  let articleId: string
  let opportunityId: string
  let productId: string

  beforeAll(async () => {
    harness = await setupTestDb('web_article_detail')
  }, 60_000)

  afterAll(async () => {
    await harness?.close()
  })

  async function anArticle(accountId: string, slug: string) {
    const { rows: opportunity } = await harness.pool.query<{ id: string }>(
      `INSERT INTO opportunities
         (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
          impact_score, confidence, reason_template_key, recommended_action, rules_version)
       VALUES ($1,'uncovered_commercial_query','query_cluster',$2,'[]'::jsonb,'high',
          80, 70, 'uncovered_commercial_query.default', 'create', 'test-rules')
       RETURNING id`,
      [accountId, `cluster:${slug}`],
    )
    const { rows: topic } = await harness.pool.query<{ id: string }>(
      `INSERT INTO topics (account_id, opportunity_id, title, intent_class, source, scheduled_date)
       VALUES ($1,$2,$3,'buying_guide','auto','2026-10-01')
       RETURNING id`,
      [accountId, opportunity[0]!.id, slug],
    )
    const { rows: article } = await harness.pool.query<{ id: string }>(
      `INSERT INTO articles (account_id, topic_id, title, slug, target_keyword)
       VALUES ($1,$2,$3,$4,'best trail shoes') RETURNING id`,
      [accountId, topic[0]!.id, slug, slug],
    )
    return { opportunityId: opportunity[0]!.id, topicId: topic[0]!.id, articleId: article[0]!.id }
  }

  beforeEach(async () => {
    await truncateAll(harness.pool)
    const { rows } = await harness.pool.query<{ id: string; email: string }>(
      "INSERT INTO accounts (email) VALUES ('mine@example.com'), ('theirs@example.com') RETURNING id, email",
    )
    mine = rows.find((row) => row.email === 'mine@example.com')!.id
    theirs = rows.find((row) => row.email === 'theirs@example.com')!.id

    const seeded = await anArticle(mine, 'trail-shoe-guide')
    topicId = seeded.topicId
    articleId = seeded.articleId
    opportunityId = seeded.opportunityId

    const scope = accountScope(mine)
    await upsertProducts(harness.db, scope, [
      {
        shopifyProductId: '3001',
        title: 'Trailhead 4',
        rawBodyHtml: null,
        productType: 'Shoes',
        tags: [],
        variants: [{ variantId: 'v1', price: 129, compareAtPrice: null, available: true, options: {} }],
        priceRange: { min: 129, max: 129, currency: 'EUR' },
        updatedAt: new Date('2026-09-01T00:00:00Z'),
        checksum: 'sum-3001',
      },
    ])
    productId = (await productIdsByShopifyId(harness.db, scope, ['3001'])).get('3001')!

    await saveDraftBody(harness.db, scope, articleId, {
      title: 'The trail shoe guide',
      metaDescription: 'Everything about trail shoes.',
      body: {
        intro: 'We tested {{p1}} on wet granite.',
        sections: [{ heading: 'Grip', body: 'The outsole matters most.' }],
        faq: [{ question: 'Are they waterproof?', answer: 'No.' }],
      },
    })
    await insertArticleProductRefs(harness.db, scope, articleId, [
      { productId, familyId: null, refType: 'mention', placeholderKey: 'p1', fieldsRendered: ['title', 'price'] },
    ])
  })

  const detail = (accountId: string | null, id: string) =>
    withAccount(
      makeGetArticleHandler({ db: harness.db }),
      async () => accountId,
    )(new Request(`http://localhost/api/articles/${id}`), { params: Promise.resolve({ articleId: id }) })

  const read = async (accountId: string, id: string) => {
    const response = await detail(accountId, id)
    expect(response.status).toBe(200)
    return articleDetailResponseSchema.parse(await response.json())
  }

  /**
   * The times the story is ordered by are minutes apart on purpose. The
   * article's own row is timestamped by Postgres and the decision by this
   * process, so leaving both at "now" puts a few milliseconds of clock
   * difference between two machines in charge of what the merchant reads.
   */
  const REJECTED_AFTER = 60_000
  const OVERRODE_AFTER = 120_000

  const rejectedByTheJudge = async () => {
    await insertGateDecision(
      harness.db,
      accountScope(mine),
      {
        topicId,
        gate: 3,
        rulesVersion: 'rules-test-v1',
        outcome: 'rejected_after_repair',
        scoresJson: {
          scores: { informationGain: 2, factualGrounding: 4 },
          justifications: { informationGain: 'Says nothing a product page does not.' },
          failed_criteria: ['informationGain'],
        },
        reasonUserFacing: 'gate3.below_quality_bar',
        promptVersion: 'judge.v1',
        modelId: 'claude-test',
      },
      new Date(Date.now() + REJECTED_AFTER),
    )
    await markArticleRejectedByGate(harness.db, accountScope(mine), articleId)
  }

  it('renders the article as it would publish, with the live price resolved into it', async () => {
    const body = await read(mine, articleId)
    expect(body.article.title).toBe('The trail shoe guide')
    expect(body.html).toContain('Trailhead 4')
    expect(body.html).toContain('129.00 EUR')
    // The marker itself never reaches a reader.
    expect(body.html).not.toContain('{{p1}}')
  })

  it('bites: an article whose product left the store still loads, so the decisions on it stay reachable', async () => {
    const withProduct = await read(mine, articleId)
    expect(withProduct.html).not.toBe('')

    await harness.pool.query('DELETE FROM products WHERE id = $1', [productId])

    const response = await detail(mine, articleId)
    // 200, not a refusal: the same page carries the quality report and the
    // override, and refusing it would take both away at the one moment the
    // merchant needs them.
    expect(response.status).toBe(200)
    const after = articleDetailResponseSchema.parse(await response.json())
    expect(after.html).toBe('')
    expect(after.article.title).toBe('The trail shoe guide')
  })

  it('names what would be set on the page, and the opportunity it came from', async () => {
    const body = await read(mine, articleId)
    expect(body.metadata.slug).toBe('trail-shoe-guide')
    expect(body.metadata.targetKeyword).toBe('best trail shoes')
    expect(body.metadata.metaDescription).toBe('Everything about trail shoes.')
    expect(body.metadata.opportunityId).toBe(opportunityId)
  })

  it('lists the products the article rests on', async () => {
    const body = await read(mine, articleId)
    expect(body.evidencePack).toEqual([{ productId, title: 'Trailhead 4' }])
  })

  it('surfaces the judge’s scores and its own sentences, with the grader that produced them', async () => {
    await rejectedByTheJudge()
    const body = await read(mine, articleId)

    expect(body.qualityReport).not.toBeNull()
    expect(body.qualityReport!.scores.informationGain).toBe(2)
    expect(body.qualityReport!.justifications.informationGain).toBe(
      'Says nothing a product page does not.',
    )
    // The grader is named because the screen labels the justification as
    // model-written from these two fields.
    expect(body.qualityReport!.modelId).toBe('claude-test')
    expect(body.qualityReport!.promptVersion).toBe('judge.v1')
    expect(body.qualityReport!.passed).toBe(false)
  })

  it('bites: a graded article with no grader recorded reports no quality report at all', async () => {
    await insertGateDecision(harness.db, accountScope(mine), {
      topicId,
      gate: 3,
      rulesVersion: 'rules-test-v1',
      outcome: 'rejected_judge',
      scoresJson: { scores: { informationGain: 2 }, justifications: { informationGain: 'Thin.' } },
      reasonUserFacing: 'gate3.below_quality_bar',
      promptVersion: null,
      modelId: null,
    })

    const body = await read(mine, articleId)
    // An unattributable justification is a model's sentences with nothing
    // saying so. Rather than show them unlabelled, we show none.
    expect(body.qualityReport).toBeNull()
  })

  it('has no quality report before anything has graded the article', async () => {
    const body = await read(mine, articleId)
    expect(body.qualityReport).toBeNull()
  })

  it('tells the story of the article from the rows that recorded it', async () => {
    await rejectedByTheJudge()
    await harness.pool.query(
      "INSERT INTO refresh_log (article_id, refreshed_at) VALUES ($1, now() + interval '1 day')",
      [articleId],
    )
    const body = await read(mine, articleId)
    expect(body.history.map((entry) => entry.event)).toEqual(['generated', 'rejected', 'refreshed'])
  })

  it('records the override on the story once the merchant has overruled us', async () => {
    await rejectedByTheJudge()
    await markArticleOverridden(harness.db, accountScope(mine), articleId)
    await insertGateDecision(
      harness.db,
      accountScope(mine),
      {
        topicId,
        gate: 3,
        rulesVersion: 'rules-test-v1',
        outcome: 'overridden',
        scoresJson: { scores: { informationGain: 2 } },
        reasonUserFacing: null,
        promptVersion: 'judge.v1',
        modelId: 'claude-test',
      },
      new Date(Date.now() + OVERRODE_AFTER),
    )

    const body = await read(mine, articleId)
    expect(body.history.map((entry) => entry.event)).toContain('overridden')
    expect(body.article.publishedViaOverride).toBe(true)
    expect(body.article.state).toBe('draft')
  })

  it('bites: an overridden article still shows the objections the judge wrote', async () => {
    await rejectedByTheJudge()
    const overrodeAt = new Date(Date.now() + OVERRODE_AFTER)
    const result = await publishAnyway(
      { db: harness.db, now: () => overrodeAt },
      { accountId: mine, articleId, acknowledgedCriteria: ['informationGain'] },
    )
    expect(result.ok).toBe(true)

    const body = await read(mine, articleId)

    // The moment a merchant most needs to read what we objected to is after
    // they have decided to act against it.
    expect(body.qualityReport).not.toBeNull()
    expect(body.qualityReport!.justifications.informationGain).toBe(
      'Says nothing a product page does not.',
    )
    expect(body.qualityReport!.scores.informationGain).toBe(2)
    expect(body.qualityReport!.scores.factualGrounding).toBe(4)
    expect(body.qualityReport!.passed).toBe(false)
    // Still attributable, so the screen can say the sentences are model-written.
    expect(body.qualityReport!.modelId).toBe('claude-test')
    expect(body.qualityReport!.promptVersion).toBe('judge.v1')
  })

  it('bites: the refusal stays in the story after the merchant overrules it', async () => {
    await rejectedByTheJudge()
    await publishAnyway(
      { db: harness.db, now: () => new Date(Date.now() + OVERRODE_AFTER) },
      { accountId: mine, articleId, acknowledgedCriteria: ['informationGain'] },
    )

    const events = (await read(mine, articleId)).history.map((entry) => entry.event)
    expect(events).toContain('rejected')
    expect(events).toContain('overridden')
    expect(events.indexOf('rejected')).toBeLessThan(events.indexOf('overridden'))
  })

  it('never lets the quarantined product description reach the page', async () => {
    const raw = await (await detail(mine, articleId)).text()
    expect(raw).not.toContain('Premium quality')
    expect(raw).not.toContain('the finest there is')
  })

  it('answers another store’s article exactly as one that never existed', async () => {
    const theirs2 = await anArticle(theirs, 'their-guide')
    expect((await detail(mine, theirs2.articleId)).status).toBe(404)
    expect((await detail(mine, '00000000-0000-0000-0000-000000000000')).status).toBe(404)
  })

  it('refuses an unsigned-in caller', async () => {
    expect((await detail(null, articleId)).status).toBe(401)
  })
})
