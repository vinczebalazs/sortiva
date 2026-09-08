import { ROUTES, routeKey, type RouteDefinition } from '@sortiva/core'
import { markWorkerRunning } from '@sortiva/core/observability/health'
import { installQueueSchema, type WorkerUtils } from '@sortiva/jobs/runtime/testing'
import { accountScope, insertMinimalOpportunity, schema, type Database } from '@sortiva/db'
import {
  TEST_DATABASE_URL,
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * What every endpoint actually answers, held against the shape it declares.
 *
 * The contract check compares the declarations to each other and to the route
 * files that exist on disk. It has never compared an answer to a declaration,
 * which is how one endpoint spent its whole life declared as a different
 * endpoint's response with nothing red — the declaration demanded three fields
 * the handler never sends and omitted two it does, and only a person reading
 * both by eye ever found it.
 *
 * So the answers are collected by *driving the real route file* against a real
 * database, and parsed with the schema the route table declares for that route.
 * Nothing here re-describes a handler: the module under test is the same
 * `route.ts` Next.js mounts, found from the contract's own path, and the
 * session wrapper, the dependency wiring and the SQL are all the real ones.
 *
 * The list of routes this cannot drive is derived from the table rather than
 * kept by hand, so a route added tomorrow is either driven here or named in
 * `UNDRIVABLE` with a reason. Being absent is not one of the options.
 */

/** The account every driven request belongs to; the mock below reads it. */
let currentAccountId = ''

// `withAccount` resolves the account from Auth.js at request time. Booting the
// real one would mean an OIDC discovery call to Google before any handler ran.
vi.mock('../../api/auth/_lib/auth', () => ({
  auth: async () => ({ user: { id: currentAccountId } }),
  handlers: {},
}))

const available = await databaseAvailable()

// ── What a driver hands the runner ───────────────────────────────────────────

interface Driven {
  /** Values for the `{param}` segments of the contract path. */
  readonly params?: Readonly<Record<string, string>>
  readonly query?: string
  readonly body?: unknown
  /**
   * The exact bytes to send, for a receiver whose signature covers them. Takes
   * precedence over `body`, which is otherwise serialised here.
   */
  readonly rawBody?: string
  readonly headers?: Readonly<Record<string, string>>
  /** Only where the contract declares something other than 200. */
  readonly status?: number
}

interface SeedContext {
  readonly db: Database
  readonly accountId: string
}

type Driver = (context: SeedContext) => Promise<Driven> | Driven

/** A route that needs nothing but a signed-in account. */
const bare: Driver = () => ({})

// ── Seeding ──────────────────────────────────────────────────────────────────

const RULES_VERSION = 'a'.repeat(64)
const NOW = new Date('2026-09-08T09:00:00.000Z')

async function seedOpportunity(
  context: SeedContext,
  overrides: Parameters<typeof insertMinimalOpportunity>[2] extends infer T
    ? Partial<T>
    : never = {},
): Promise<{ id: string }> {
  return insertMinimalOpportunity(
    context.db,
    accountScope(context.accountId),
    {
      signalType: 'uncovered_commercial_query',
      entityType: 'query_cluster',
      entityRef: 'best trail running shoes',
      evidenceJson: [
        {
          key: 'keyword',
          value: 'best trail running shoes',
          source: 'content_inventory',
          fetchedAt: NOW.toISOString(),
        },
        // The calendar scheduler refuses to guess which article template a
        // topic needs; it reads this fact or stops.
        {
          key: 'intent_class',
          value: 'buying_guide',
          source: 'content_inventory',
          fetchedAt: NOW.toISOString(),
        },
      ],
      recommendedAction: 'create',
      status: 'new',
      reasonTemplateKey: 'uncovered_commercial_query.create',
      reasonParams: { keyword: 'best trail running shoes' },
      limitedIntelligence: false,
      rulesVersion: RULES_VERSION,
      ...overrides,
    },
    NOW,
  )
}

/** The store has claimed its domain — several routes refuse before that. */
async function seedDomain(
  context: SeedContext,
  state: 'ready_for_planning' | 'needs_confirmation' = 'ready_for_planning',
): Promise<void> {
  await context.db.insert(schema.domains).values({
    accountId: context.accountId,
    domainNormalized: 'example.com',
    platform: 'shopify',
    state,
  })
}

/** A connected Shopify store. The token is never decrypted by the routes driven here. */
async function seedShopifyConnection(context: SeedContext): Promise<void> {
  await context.db.insert(schema.shopifyConns).values({
    accountId: context.accountId,
    shopHandle: 'example-store',
    accessToken: 'ciphertext-placeholder',
    grantedScopes: ['read_products', 'read_content', 'write_content'],
  })
}

/** A connected Search Console property. */
async function seedGscConnection(context: SeedContext): Promise<void> {
  await context.db.insert(schema.gscConns).values({
    accountId: context.accountId,
    property: 'sc-domain:example.com',
    tokens: 'ciphertext-placeholder',
  })
}

/** A live subscription, which is what the generating and publishing routes gate on. */
async function seedEntitlement(context: SeedContext): Promise<void> {
  await context.db.insert(schema.subscriptions).values({
    accountId: context.accountId,
    stripeSubscriptionId: `sub_${context.accountId.slice(0, 8)}`,
    priceId: 'price_test_monthly',
    status: 'active',
    currentPeriodEnd: new Date('2026-10-08T09:00:00.000Z'),
  })
}

/** The store profile the confirmation screen and the keyword routes read. */
async function seedPersona(context: SeedContext): Promise<void> {
  await context.db.insert(schema.personas).values({
    accountId: context.accountId,
    description: 'We sell trail running shoes for wide feet.',
    productCategories: ['footwear'],
    language: 'en',
    country: 'GB',
    audience: 'Trail runners',
    tone: 'Plain and practical',
    promptVersion: 'v1',
    modelId: 'test-model',
  })
}

/**
 * An onboarding run, which is what the progress screen reads.
 *
 * The detected store name lives in the `detect` step's recorded output rather
 * than in a column, so the Shopify install route reads it from there.
 */
async function seedIngestionRun(context: SeedContext, shopHandle?: string): Promise<void> {
  const [run] = await context.db
    .insert(schema.ingestionJobs)
    .values({ accountId: context.accountId, runId: 'route-answers-run', status: 'running' })
    .returning({ id: schema.ingestionJobs.id })
  if (shopHandle === undefined) return
  await context.db.insert(schema.jobSteps).values({
    jobId: run!.id,
    step: 'detect',
    state: 'succeeded',
    idempotencyKey: 'route-answers-detect',
    outputRef: { shopHandle },
  })
}

async function seedTopic(
  context: SeedContext,
  overrides: Partial<typeof schema.topics.$inferInsert> = {},
): Promise<{ id: string; opportunityId: string }> {
  const opportunity = await seedOpportunity(context)
  const [topic] = await context.db
    .insert(schema.topics)
    .values({
      accountId: context.accountId,
      opportunityId: opportunity.id,
      title: 'Best trail shoes for wide feet',
      targetKeyword: 'trail shoes wide feet',
      intentClass: 'buying_guide',
      source: 'auto',
      scheduledDate: '2026-09-25',
      state: 'planned',
      ...overrides,
    })
    .returning({ id: schema.topics.id })
  return { id: topic!.id, opportunityId: opportunity.id }
}

async function seedArticle(
  context: SeedContext,
  overrides: Partial<typeof schema.articles.$inferInsert> = {},
): Promise<{ id: string; topicId: string }> {
  const topic = await seedTopic(context)
  const [article] = await context.db
    .insert(schema.articles)
    .values({
      accountId: context.accountId,
      topicId: topic.id,
      title: 'Best trail shoes for wide feet',
      slug: 'best-trail-shoes-for-wide-feet',
      targetKeyword: 'trail shoes wide feet',
      metaDescription: 'Which trail shoes actually fit a wide foot, and why.',
      bodyJson: {
        intro: 'Wide feet and narrow shoes are a bad match.',
        sections: [{ heading: 'Fit', body: 'Look at the last, not the size.' }],
        faq: [],
      },
      state: 'in_review',
      ...overrides,
    })
    .returning({ id: schema.articles.id })
  return { id: article!.id, topicId: topic.id }
}

// ── Which routes can be driven, and which are named instead ──────────────────

/**
 * Routes that cannot be driven here, each with the reason.
 *
 * A name and a reason is a thing a reader can act on; an absence is not. Two
 * more routes are excluded by the table itself rather than by this list — see
 * `derivedExceptions`.
 */
const UNDRIVABLE: Readonly<Record<string, string>> = {
  'POST /api/preview':
    'the only unauthenticated route: it verifies a Cloudflare bot-challenge token, fetches a ' +
    "stranger's website and writes a summary with a model call. All three are live outside calls.",
  'GET /api/billing/plan':
    'reads the live prices out of Stripe on every request, because no amount may be hardcoded ' +
    'anywhere in our code.',
  'POST /api/billing/checkout': 'creates a Stripe Checkout session through Stripe.',
  'POST /api/billing/portal': "creates a Stripe Customer Portal link through Stripe's API.",
  'GET /api/publish/blogs':
    "lists the blogs on the merchant's Shopify store, which means their access token and a call " +
    'to Shopify.',
  'POST /api/publish/target':
    'selects or creates a blog on the Shopify store, which is a write against Shopify.',
  'GET /api/gsc/properties':
    'asks Google which Search Console properties the connected account can read.',
}

/**
 * Endpoints whose answer its own declaration rejects **today**.
 *
 * This is the finding, not a workaround for it. A wrong declaration belongs to
 * whoever holds the frozen contract and a wrong handler to the lane that owns
 * it, so neither is corrected here — but a mismatch that merely made this suite
 * red would be reverted by the next person to see it, and a mismatch nobody
 * wrote down is one nobody fixes. So each is recorded with the exact complaint
 * it produces, and the check asserts the complaint is **still** exactly that:
 * the day the endpoint and its declaration agree, this file goes red asking for
 * the entry to be deleted, and the day the mismatch changes shape it goes red
 * saying so.
 */
interface KnownMismatch {
  /** What parsing the real answer complains about, verbatim. */
  readonly issues: readonly string[]
  readonly why: string
}

const KNOWN_MISMATCHES: Readonly<Record<string, KnownMismatch>> = {
  'POST /api/gsc/oauth/start': {
    issues: ['url: Invalid input: expected string, received undefined'],
    why:
      'The handler answers `{ redirectUrl }`; the contract, and the Shopify install route beside ' +
      'it, say `{ url }`. The Settings screen reads `body.url` and throws when it is missing, so ' +
      '"Connect Search Console" fails there on a deployed server; the onboarding step reads ' +
      'either name and works. Handler: apps/web/app/api/gsc/_lib/handlers.ts:42.',
  },
  'GET /api/articles/{articleId}/export': {
    issues: ['files: Invalid input: expected record, received array'],
    why:
      'The handler answers a list of files, each with its own name and contents; the contract ' +
      'declares one object mapping name to contents. The screen and the export bundle both use ' +
      'the list. Handler: apps/web/app/api/articles/_lib/delivery.ts:70.',
  },
}

const DRIVERS: Readonly<Record<string, Driver>> = {
  'GET /api/health': () => {
    // The health route is 200 only while the background worker has reported in.
    // This is the worker's own process-wide record, not a stand-in for one.
    markWorkerRunning(NOW)
    return {}
  },
  'GET /api/account': bare,
  'GET /api/settings': bare,
  'PATCH /api/settings': () => ({ body: { publishHour: 9 } }),
  'POST /api/publish/mode': () => ({ body: { delivery: 'export' } }),
  'POST /api/publish/grant/start': async (context) => {
    await seedShopifyConnection(context)
    return {}
  },
  'POST /api/account/delete': () => ({ body: { confirmation: 'DELETE' } }),
  'POST /api/domain/claim': () => ({ body: { domain: 'example.com' } }),
  'GET /api/ingestion/status': async (context) => {
    await seedIngestionRun(context)
    return {}
  },
  'POST /api/shopify/oauth/start': async (context) => {
    await seedDomain(context)
    await seedIngestionRun(context, 'example-store')
    return {}
  },
  'POST /api/gsc/oauth/start': bare,
  'POST /api/gsc/property': async (context) => {
    await seedDomain(context)
    await seedGscConnection(context)
    return { body: { siteUrl: 'sc-domain:example.com' } }
  },
  'POST /api/gsc/skip': bare,
  'GET /api/profile': async (context) => {
    await seedPersona(context)
    return {}
  },
  'POST /api/profile/confirm': async (context) => {
    await seedDomain(context, 'needs_confirmation')
    await seedPersona(context)
    return {
    body: {
      description: 'We sell trail running shoes for wide feet.',
      language: 'en',
      country: 'GB',
      audience: 'Trail runners',
      tone: 'Plain and practical',
      topProductIds: [],
    },
  }
  },
  'POST /api/profile/keywords': async (context) => {
    await seedPersona(context)
    return { body: { term: 'wide trail shoes' } }
  },
  'DELETE /api/profile/keywords/{keywordId}': async (context) => {
    const [keyword] = await context.db
      .insert(schema.keywords)
      .values({
        accountId: context.accountId,
        term: 'wide trail shoes',
        language: 'en',
        country: 'GB',
        source: 'manual',
      })
      .returning({ id: schema.keywords.id })
    return { params: { keywordId: keyword!.id } }
  },
  'POST /api/profile/competitors': async (context) => {
    await seedDomain(context)
    await seedPersona(context)
    return { body: { domain: 'competitor-store.com' } }
  },
  'DELETE /api/profile/competitors/{competitorId}': async (context) => {
    const [competitor] = await context.db
      .insert(schema.competitors)
      .values({
        accountId: context.accountId,
        domainNormalized: 'competitor-store.com',
        source: 'manual',
      })
      .returning({ id: schema.competitors.id })
    return { params: { competitorId: competitor!.id } }
  },
  'POST /api/products/families/report': async (context) => {
    const [family] = await context.db
      .insert(schema.productFamilies)
      .values({
        accountId: context.accountId,
        name: 'Trail shoes',
        groupingSource: 'collection',
        confidence: 'high',
      })
      .returning({ id: schema.productFamilies.id })
    return { body: { familyId: family!.id, reason: 'These are two different families.' } }
  },
  'GET /api/opportunities': bare,
  'GET /api/opportunities/scan-status': bare,
  'GET /api/opportunities/{id}': async (context) => ({
    params: { id: (await seedOpportunity(context)).id },
  }),
  'POST /api/opportunities/{id}/schedule': async (context) => ({
    params: { id: (await seedOpportunity(context, { status: 'accepted' })).id },
    body: {},
  }),
  'POST /api/opportunities/{id}/dismiss': async (context) => ({
    params: { id: (await seedOpportunity(context)).id },
  }),
  'POST /api/opportunities/{id}/undismiss': async (context) => ({
    params: { id: (await seedOpportunity(context, { status: 'dismissed' })).id },
  }),
  'POST /api/recommendations': async (context) => {
    await seedEntitlement(context)
    return {
      body: {
        opportunityId: (
          await seedOpportunity(context, { recommendedAction: 'optimize', entityType: 'url' })
        ).id,
      },
    }
  },
  'GET /api/recommendations': async (context) => ({
    query: `opportunityId=${(await seedOpportunity(context, { recommendedAction: 'optimize', entityType: 'url' })).id}`,
  }),
  'POST /api/recommendations/{id}/apply': async (context) => {
    const opportunity = await seedOpportunity(context, {
      recommendedAction: 'optimize',
      entityType: 'url',
    })
    const [recommendation] = await context.db
      .insert(schema.optimizeRecommendations)
      .values({
        opportunityId: opportunity.id,
        pageUrl: 'https://example.com/collections/trail',
        recommendationJson: { title: 'Trail shoes for wide feet' },
        promptVersion: 'v1',
        modelId: 'test-model',
        rulesVersion: RULES_VERSION,
        state: 'valid',
      })
      .returning({ id: schema.optimizeRecommendations.id })
    return { params: { id: recommendation!.id } }
  },
  'GET /api/calendar': () => ({ query: 'from=2026-09-01&to=2026-09-30' }),
  'POST /api/calendar/topics': async (context) => {
    await seedEntitlement(context)
    return { body: { title: 'Winter fell running kit', date: '2026-09-26' } }
  },
  'POST /api/calendar/topics/{topicId}/veto': async (context) => ({
    params: { topicId: (await seedTopic(context)).id },
  }),
  'POST /api/calendar/topics/{topicId}/move': async (context) => ({
    params: { topicId: (await seedTopic(context)).id },
    body: { date: '2026-09-26' },
  }),
  'POST /api/calendar/topics/{topicId}/pin': async (context) => ({
    params: { topicId: (await seedTopic(context)).id },
    body: { pinned: true },
  }),
  'GET /api/articles': bare,
  'GET /api/articles/{articleId}': async (context) => ({
    params: { articleId: (await seedArticle(context)).id },
  }),
  'POST /api/articles/{articleId}/approve': async (context) => ({
    params: { articleId: (await seedArticle(context)).id },
  }),
  'POST /api/articles/{articleId}/discard': async (context) => ({
    params: { articleId: (await seedArticle(context)).id },
  }),
  'POST /api/articles/{articleId}/publish-anyway': async (context) => {
    await seedEntitlement(context)
    return {
      params: { articleId: (await seedArticle(context, { state: 'rejected' })).id },
      body: { acknowledgedCriteria: ['grounding'] },
    }
  },
  'GET /api/articles/{articleId}/export': async (context) => ({
    params: { articleId: (await seedArticle(context)).id },
  }),
  'POST /api/articles/{articleId}/published-url': async (context) => {
    await seedDomain(context)
    return {
      params: { articleId: (await seedArticle(context, { state: 'published' })).id },
      body: { url: 'https://example.com/blogs/news/best-trail-shoes' },
    }
  },
  'POST /api/articles/{articleId}/refresh': async (context) => {
    await seedEntitlement(context)
    return { params: { articleId: (await seedArticle(context, { state: 'published' })).id } }
  },
  'GET /api/products': bare,
  'GET /api/products/families': bare,
  'GET /api/performance/overview': bare,
  'GET /api/performance/search-console': () => ({ query: 'dimension=query&window=28d' }),
  'GET /api/notifications': bare,
  'POST /api/notifications/seen': bare,
  'POST /api/notifications/{notificationId}/read': async (context) => {
    const [notification] = await context.db
      .insert(schema.notifications)
      .values({
        accountId: context.accountId,
        type: 'article_published',
        dedupeKey: 'route-answers',
        payloadJson: {},
      })
      .returning({ id: schema.notifications.id })
    return { params: { notificationId: notification!.id } }
  },
  'GET /api/attention': bare,
  'POST /api/webhooks/stripe': () => {
    const rawBody = JSON.stringify({
      id: 'evt_route_answers',
      object: 'event',
      type: 'customer.subscription.updated',
      created: Math.floor(NOW.getTime() / 1000),
      data: { object: { id: 'sub_route_answers', object: 'subscription', status: 'active' } },
    })
    return { rawBody, headers: { 'stripe-signature': stripeSignature(rawBody) } }
  },
  'POST /api/webhooks/shopify/{topic}': () => {
    const rawBody = JSON.stringify({ id: 1, title: 'Trail shoe' })
    return {
      params: { topic: 'products-update' },
      rawBody,
      headers: {
        'x-shopify-hmac-sha256': createHmac('sha256', process.env.SHOPIFY_API_SECRET ?? '')
          .update(rawBody)
          .digest('base64'),
        'x-shopify-webhook-id': 'route-answers-delivery',
        'x-shopify-topic': 'products/update',
        'x-shopify-shop-domain': 'example-store.myshopify.com',
      },
    }
  },
  'POST /api/webhooks/resend': () => {
    const rawBody = JSON.stringify({
      type: 'email.delivered',
      data: { to: ['someone@example.com'], email_id: 'route-answers-message' },
    })
    return { rawBody, headers: resendSignatureHeaders(rawBody) }
  },
}

/** Stripe's own scheme: `t=<unix>,v1=<hex hmac of "<t>.<body>">`. */
function stripeSignature(rawBody: string): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const digest = createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET ?? '')
    .update(`${timestamp}.${rawBody}`)
    .digest('hex')
  return `t=${timestamp},v1=${digest}`
}

/** The Svix scheme Resend uses: the signature covers `<id>.<timestamp>.<body>`. */
function resendSignatureHeaders(rawBody: string): Record<string, string> {
  const secret = process.env.RESEND_WEBHOOK_SECRET ?? ''
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const id = 'msg_route_answers'
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64')
  return {
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${signature}`,
  }
}

// ── Driving one route ────────────────────────────────────────────────────────

/** `{id}` in the contract is `[id]` on disk. */
function moduleSpecifierFor(path: string): string {
  const segments = path
    .replace(/^\/api\//, '')
    .split('/')
    .map((segment) =>
      segment.startsWith('{') && segment.endsWith('}') ? `[${segment.slice(1, -1)}]` : segment,
    )
  return `../../api/${segments.join('/')}/route`
}

type RouteHandler = (request: Request, context: unknown) => Promise<Response>

async function handlerFor(route: RouteDefinition): Promise<RouteHandler> {
  const module = (await import(/* @vite-ignore */ moduleSpecifierFor(route.path))) as Record<
    string,
    unknown
  >
  const handler = module[route.method]
  if (typeof handler !== 'function') {
    throw new Error(`${routeKey(route)}: the route file exports no ${route.method}`)
  }
  return handler as RouteHandler
}

function urlFor(route: RouteDefinition, driven: Driven): string {
  const path = route.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = driven.params?.[name]
    if (value === undefined) throw new Error(`${routeKey(route)}: no value for {${name}}`)
    return encodeURIComponent(value)
  })
  return `http://localhost${path}${driven.query ? `?${driven.query}` : ''}`
}

interface Answer {
  readonly status: number
  readonly text: string
  readonly json: unknown
}

async function drive(route: RouteDefinition, driven: Driven): Promise<Answer> {
  const handler = await handlerFor(route)
  const request = new Request(urlFor(route, driven), {
    method: route.method,
    ...(driven.rawBody === undefined && driven.body === undefined
      ? { headers: { ...driven.headers } }
      : {
          body: driven.rawBody ?? JSON.stringify(driven.body),
          headers: { 'content-type': 'application/json', ...driven.headers },
        }),
  })
  const response = await handler(request, { params: Promise.resolve(driven.params ?? {}) })
  const text = await response.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, text, json }
}

/**
 * Routes the table itself says cannot answer a JSON body here, so nobody has to
 * remember to list them: a server-sent-event stream's declared schema describes
 * one event rather than the response.
 */
function derivedExceptions(route: RouteDefinition): string | null {
  if (route.sse === true) {
    return 'streams server-sent events; the declared schema describes one event, not the response'
  }
  return null
}

// ── The suite ────────────────────────────────────────────────────────────────

describe('every route answers the shape it declares', () => {
  it('is either driven below or named as one that cannot be', () => {
    const unaccounted = ROUTES.filter(
      (route) =>
        derivedExceptions(route) === null &&
        DRIVERS[routeKey(route)] === undefined &&
        UNDRIVABLE[routeKey(route)] === undefined,
    ).map(routeKey)

    expect(
      unaccounted,
      'a route in the frozen table is neither driven against its declared schema nor named as ' +
        'one that cannot be — add a driver, or name it in UNDRIVABLE with the reason',
    ).toEqual([])
  })

  it('names no route both ways', () => {
    const both = Object.keys(DRIVERS).filter((key) => UNDRIVABLE[key] !== undefined)
    expect(both, 'a route is both driven and named as undrivable').toEqual([])
  })

  it('names nothing that has left the table', () => {
    const inTable = new Set(ROUTES.map(routeKey))
    const stale = [
      ...Object.keys(DRIVERS),
      ...Object.keys(UNDRIVABLE),
      ...Object.keys(KNOWN_MISMATCHES),
    ].filter((key) => !inTable.has(key))
    expect(stale, 'a driver or an exception names a route the contract no longer declares').toEqual(
      [],
    )
  })

  it('gives every route it cannot drive a reason a person can read', () => {
    const wordless = Object.entries(UNDRIVABLE)
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([key]) => key)
    expect(wordless, 'naming a route without saying why is the same as skipping it').toEqual([])
  })

  it('records a mismatch only against a route it actually drives', () => {
    const unreachable = Object.keys(KNOWN_MISMATCHES).filter(
      (key) => DRIVERS[key] === undefined,
    )
    expect(
      unreachable,
      'a recorded mismatch on a route nothing drives can never be checked, so it can never be ' +
        'noticed when it is fixed',
    ).toEqual([])
  })
})

describe.skipIf(!available)('the answers themselves', () => {
  let harness: TestDb

  let queue: WorkerUtils
  const databaseUrlBefore = process.env.DATABASE_URL

  beforeAll(async () => {
    harness = await setupTestDb('web_route_answers')
    const url = new URL(TEST_DATABASE_URL)
    url.pathname = `/${harness.databaseName}`
    // The route files build their own database handle from the environment, the
    // same way they do in production. Set before any of them is imported.
    process.env.DATABASE_URL = url.toString()

    // The queue's own tables are created by the worker at start-up rather than
    // by our migrations, so a database built from migrations alone has no queue
    // in it and every route that queues work fails on the missing schema.
    queue = await installQueueSchema(url.toString())

    // Configuration these routes refuse to run without. Values, not stand-ins:
    // an OAuth start builds a real URL out of the client id, and the token
    // cipher really does encrypt with this key.
    process.env.APP_URL ??= 'http://localhost:3000'
    process.env.AUTH_SECRET ??= 'route-answers-test-secret'
    process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64')
    process.env.SHOPIFY_API_KEY ??= 'test-shopify-key'
    process.env.SHOPIFY_API_SECRET ??= 'test-shopify-secret'
    process.env.AUTH_GOOGLE_ID ??= 'test-google-client-id'
    process.env.AUTH_GOOGLE_SECRET ??= 'test-google-client-secret'
    process.env.GSC_OAUTH_CLIENT_ID ??= 'test-gsc-client-id'
    process.env.GSC_OAUTH_CLIENT_SECRET ??= 'test-gsc-client-secret'
    // The webhook receivers verify a signature before touching the body, so the
    // three drivers below sign what they send with these. Setting the Stripe
    // key lets its client be constructed; no route driven here calls Stripe.
    process.env.STRIPE_SECRET_KEY ??= 'sk_test_route_answers'
    process.env.STRIPE_WEBHOOK_SECRET ??= 'whsec_route_answers'
    process.env.RESEND_WEBHOOK_SECRET ??= `whsec_${Buffer.alloc(24, 3).toString('base64')}`
    // The SEO vendor is billable per call; its own mock mode is what every
    // other database-backed suite runs against.
    process.env.SEO_PROVIDER_MODE ??= 'mock'
  }, 60_000)

  afterAll(async () => {
    const { closeDb } = await import('@sortiva/db')
    await closeDb()
    await queue.release()
    await harness.close()
    // The database this suite owns is dropped on the line above, and the test
    // runner reuses a worker process for the next file. Leaving the variable
    // pointing at a database that no longer exists would break whatever runs
    // next in this process, in a way that looks nothing like this file.
    if (databaseUrlBefore === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = databaseUrlBefore
  })

  const drivable = ROUTES.filter(
    (route) => derivedExceptions(route) === null && DRIVERS[routeKey(route)] !== undefined,
  )

  it.each(drivable.map((route) => [routeKey(route), route] as const))(
    '%s',
    async (key, route) => {
      await truncateAll(harness.pool)
      currentAccountId = await insertAccount(harness.pool, 'route-answers@example.com')
      const { db } = await import('@sortiva/db')
      const context: SeedContext = { db: db(), accountId: currentAccountId }
      const driven = await DRIVERS[key]!(context)

      const answer = await drive(route, driven)
      expect(
        answer.status,
        `${key} did not succeed, so its declared shape was never tested. It answered ` +
          `${answer.status}: ${answer.text.slice(0, 300)}`,
      ).toBe(driven.status ?? route.status ?? 200)

      const parsed = route.response.safeParse(answer.json)
      const issues = parsed.success
        ? null
        : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)

      const known = KNOWN_MISMATCHES[key]
      if (known) {
        expect(
          issues,
          `${key} now answers what it declares. Delete its KNOWN_MISMATCHES entry — the finding ` +
            'it records has been fixed.',
        ).not.toBeNull()
        expect(
          issues,
          `${key} disagrees with its declaration in a different way than was recorded. Read the ` +
            `recorded finding before changing anything: ${known.why}`,
        ).toEqual(known.issues)
        return
      }

      expect(issues, `${key} answered something its own declaration rejects`).toBeNull()
    },
    30_000,
  )
})
