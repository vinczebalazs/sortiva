import {
  CANCELLATION_FACTS,
  FIXTURE_ACCOUNT_ID,
  FIXTURE_DOMAIN,
  FIXTURE_RULES_VERSION,
  fixtureOpportunities,
  fixtureScheduledTopic,
  PLAN_CANCEL_ANYTIME,
  PLAN_CAP_LINE,
  PLAN_INCLUSIONS,
  type RouteDefinition,
} from '@sortiva/core'

/**
 * One response body per route, for the MSW mock server the frontend builds
 * against before its backend lands.
 *
 * Every fixture is validated against its route's response schema by the handler
 * test, so a mock the frontend builds against can never describe a shape the
 * API will not produce.
 */

/**
 * The moment these answers describe. Exported because anything driving a screen
 * against them has to move its own clock here as well: a calendar or a chart
 * drawn around a different "today" has no cell for any of this to land in, and
 * draws an empty grid instead.
 */
export const FIXTURE_NOW = '2026-02-02T09:00:00.000Z'

const NOW = FIXTURE_NOW
const TODAY = FIXTURE_NOW.slice(0, 10)

const opportunityFixture = (source: (typeof fixtureOpportunities)[number]) => ({
  id: source.id,
  signalType: source.signalType,
  entityRef: source.entityRef,
  recommendedAction: source.recommendedAction,
  status: source.status,
  impact: source.impact,
  impactScore: source.impactScore,
  confidence: source.confidence,
  confidenceScore: source.confidenceScore,
  confidenceFactors: [
    { label: 'Search Console data', direction: 'up' as const },
    { label: '28-day window', direction: 'up' as const },
  ],
  evidence: source.evidence,
  why: { templateKey: source.reasonTemplateKey, params: source.reasonParams },
  preconditions: source.preconditions.map((code) => ({
    code,
    whatToDo: { templateKey: `precondition.${code}`, params: { products: 6 } },
  })),
  rulesVersion: source.rulesVersion,
  limitedIntelligence: source.limitedIntelligence,
  detectedAt: source.detectedAt,
  scheduledFor: null,
  expiresAt: null,
})

const topicFixture = {
  id: fixtureScheduledTopic.topicId,
  title: fixtureScheduledTopic.title,
  scheduledFor: fixtureScheduledTopic.scheduledFor,
  state: 'planned' as const,
  intentClass: 'buying_guide' as const,
  kind: 'new' as const,
  source: 'auto' as const,
  pinned: false,
  targetKeyword: 'trail running shoes for wide feet',
  monthlySearchVolume: 880,
  why: {
    templateKey: 'uncovered_commercial_query.create',
    params: { volume: 880 },
  },
  opportunityId: fixtureScheduledTopic.opportunityId,
  signalType: 'uncovered_commercial_query',
  articleId: null,
  rejection: null,
}

const articleFixture = {
  id: '66666666-6666-4666-8666-666666666666',
  title: 'Best trail running shoes for wide feet',
  state: 'published' as const,
  delivery: 'export' as const,
  publishedAt: NOW,
  publishedUrl: `https://${FIXTURE_DOMAIN}/blogs/guides/wide-fit-trail-shoes`,
  publishedViaOverride: false,
  repaired: false,
  refreshedCount: 0,
  performance: null,
}

/** Keyed by `METHOD /api/path`, matching `routeKey()`. */
export const RESPONSE_FIXTURES: Record<string, unknown> = {
  'GET /api/health': { ok: true },

  'POST /api/preview': {
    domain: FIXTURE_DOMAIN,
    summary:
      'An outdoor retailer selling trail running shoes, hiking boots and technical apparel, with a focus on fit and terrain.',
    cacheHit: false,
    generic: false,
  },

  'GET /api/account': {
    accountId: FIXTURE_ACCOUNT_ID,
    email: 'merchant@example.com',
    domain: { normalized: FIXTURE_DOMAIN, state: 'ready_for_planning', platform: 'shopify' },
    subscription: { status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: NOW },
    limitedIntelligence: false,
    connections: { shopify: 'read', searchConsole: 'connected', lastScanAt: NOW },
    servicePaused: false,
  },
  // Amounts here are fixture data, not the plan's price: the real response
  // reads them from Stripe on every request, because the app never hardcodes a
  // dollar amount. The annual figure is the monthly one less 20% over twelve
  // months, so the monthly/annual toggle has something to show.
  'GET /api/billing/plan': {
    planKey: 'pro',
    name: 'Pro',
    capLine: PLAN_CAP_LINE,
    inclusions: [...PLAN_INCLUSIONS],
    cancelAnytime: PLAN_CANCEL_ANYTIME,
    cancellationFacts: [...CANCELLATION_FACTS],
    prices: [
      { interval: 'monthly', priceId: 'price_fixture_monthly', unitAmountMinor: 8900, currency: 'usd' },
      { interval: 'annual', priceId: 'price_fixture_annual', unitAmountMinor: 85440, currency: 'usd' },
    ],
  },
  'POST /api/billing/checkout': { url: 'https://checkout.stripe.com/c/pay/cs_test_fixture' },
  'POST /api/billing/portal': { url: 'https://billing.stripe.com/p/session/fixture' },

  'GET /api/settings': settingsFixture(),
  'PATCH /api/settings': settingsFixture(),
  'GET /api/publish/blogs': {
    blogs: [{ id: 'gid://shopify/Blog/1', title: 'News', handle: 'news' }],
  },
  'POST /api/publish/target': {
    ok: true,
    blog: { id: 'gid://shopify/Blog/1', title: 'News', handle: 'news' },
  },
  'POST /api/publish/mode': { ok: true, delivery: 'auto' },
  'POST /api/publish/grant/start': { url: 'https://example.myshopify.com/admin/oauth/authorize' },
  'POST /api/account/delete': { ok: true },

  'POST /api/domain/claim': {
    normalized: FIXTURE_DOMAIN,
    state: 'ingesting',
    ingestionJobId: '77777777-7777-4777-8777-777777777777',
  },

  'GET /api/ingestion/status': ingestionFixture(),
  'GET /api/ingestion/stream': ingestionFixture(),

  'POST /api/shopify/oauth/start': { url: 'https://example.myshopify.com/admin/oauth/authorize' },
  'POST /api/gsc/oauth/start': { url: 'https://accounts.google.com/o/oauth2/v2/auth' },
  'GET /api/gsc/properties': {
    properties: [
      {
        siteUrl: `sc-domain:${FIXTURE_DOMAIN}`,
        permissionLevel: 'siteOwner',
        matchesClaimedDomain: true,
      },
    ],
  },
  'POST /api/gsc/property': { ok: true },
  'POST /api/gsc/skip': { ok: true },

  'GET /api/profile': profileFixture(),
  'POST /api/profile/confirm': { ok: true },
  'POST /api/profile/keywords': keywordFixture(),
  'DELETE /api/profile/keywords/{keywordId}': { ok: true },
  'POST /api/profile/competitors': {
    id: '99999999-9999-4999-8999-999999999999',
    domain: 'competitor.example',
    source: 'manual',
  },
  'DELETE /api/profile/competitors/{competitorId}': { ok: true },
  'POST /api/products/families/report': { ok: true },

  'GET /api/opportunities': {
    opportunities: fixtureOpportunities.map(opportunityFixture),
    counts: {
      open: 3,
      byAction: { CREATE: 1, OPTIMIZE: 1, REFRESH: 0, FIX: 0, HOLD: 1 },
    },
    lastScanAt: NOW,
    nextScanAt: '2026-02-09T06:00:00.000Z',
    // Deliberately not UTC. The instant above is the store's Monday the 9th
    // and UTC's Sunday the 8th, so a screen that formats it without this
    // shows the wrong day here rather than only on a real merchant's account.
    timezone: 'Europe/Berlin',
    limitedIntelligence: false,
    cursor: null,
  },
  'GET /api/opportunities/{id}': {
    opportunity: opportunityFixture(fixtureOpportunities[0]!),
    tasks: [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', label: 'Rewrite the collection title', state: 'open' },
    ],
    serpSnapshot: [
      { position: 1, domain: 'competitor.example', url: 'https://competitor.example/trail' },
    ],
    recommendation: null,
    history: [
      { at: NOW, from: null, to: 'new', actor: 'autopilot', reason: null },
    ],
    outcome: null,
  },
  'POST /api/opportunities/{id}/schedule': {
    topicId: fixtureScheduledTopic.topicId,
    scheduledFor: fixtureScheduledTopic.scheduledFor,
  },
  'POST /api/opportunities/{id}/dismiss': { ok: true },
  'POST /api/opportunities/{id}/undismiss': { ok: true },
  'GET /api/opportunities/scan-status': { status: 'not_started' },
  'GET /api/opportunities/scan-stream': { status: 'not_started' },
  'POST /api/recommendations': { state: 'generating', generated: true },
  // Corrected with the contract in `R-CONTRACT-2`: this fixture answered the
  // opportunity-drawer shape, which this endpoint has never returned. It now
  // answers the richest of the four real shapes — advice that exists — because
  // that is the one a screen is built against.
  'GET /api/recommendations': {
    recommendation: {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      state: 'ready',
      pageUrl: 'https://example-outdoor.com/collections/trail-shoes',
      fields: [
        {
          field: 'title',
          current: 'Trail Shoes',
          suggested: 'Trail Running Shoes for Technical Terrain',
          evidence: 'Shoppers search for the terrain, not the category.',
        },
      ],
      sections: [
        {
          heading: 'How to choose a trail shoe',
          copy: 'Start with the terrain you run on most.',
          evidence: ['Trailblazer GTX', 'Ridgeline 2'],
        },
      ],
      faq: [{ q: 'Do trail shoes run small?', a: 'Ours run half a size small.', evidence: ['Trailblazer GTX'] }],
      internalLinksIn: [{ fromUrl: 'https://example-outdoor.com/blog/sizing', anchor: 'trail shoes' }],
      internalLinksOut: [{ toUrl: 'https://example-outdoor.com/products/trailblazer', anchor: 'Trailblazer GTX' }],
      intentNote: null,
      failureReason: null,
      generatedAt: NOW,
    },
    tasks: [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        kind: 'title_rewrite',
        label: 'Rewrite the collection title',
        state: 'open',
      },
    ],
    looksApplied: null,
    appliedAt: null,
  },
  'POST /api/recommendations/{id}/apply': { ok: true },

  'GET /api/calendar': {
    topics: [topicFixture],
    paused: { active: false, reason: null },
    nextReplenishmentAt: '2026-03-01',
  },
  'POST /api/calendar/topics': {
    outcome: 'planned',
    topic: topicFixture,
    warning: null,
    convertedToOpportunityId: null,
    rejection: null,
  },
  'POST /api/calendar/topics/{topicId}/veto': { ok: true },
  'POST /api/calendar/topics/{topicId}/move': topicFixture,
  'POST /api/calendar/topics/{topicId}/pin': { ...topicFixture, pinned: true },

  'GET /api/articles': { articles: [articleFixture], cursor: null },
  'GET /api/articles/{articleId}': {
    article: articleFixture,
    html: '<h1>Best trail running shoes for wide feet</h1><p>…</p>',
    metadata: {
      targetKeyword: 'trail running shoes for wide feet',
      slug: 'wide-fit-trail-shoes',
      metaDescription: 'How to choose trail shoes when standard widths pinch.',
      familyIds: ['trail-running'],
      opportunityId: fixtureOpportunities[1]!.id,
    },
    evidencePack: [{ productId: 'trail-running-1', title: 'Trail Running 1' }],
    qualityReport: {
      scores: { informationGain: 4, factualGrounding: 4, structure: 3 },
      justifications: { informationGain: 'Adds width-specific fit guidance.' },
      promptVersion: 'judge.v1',
      modelId: 'claude-sonnet-5',
      passed: true,
    },
    history: [{ at: NOW, event: 'published' }],
  },
  'POST /api/articles/{articleId}/approve': { ok: true },
  'POST /api/articles/{articleId}/discard': { ok: true },
  'POST /api/articles/{articleId}/publish-anyway': { ok: true },
  // Three files, named and typed, because that is what the endpoint has always
  // answered and what the browser needs to hand each one to the merchant.
  'GET /api/articles/{articleId}/export': {
    files: [
      {
        filename: 'wide-fit-trail-shoes.md',
        mimeType: 'text/markdown',
        content: '# Best trail running shoes for wide feet\n',
      },
      {
        filename: 'wide-fit-trail-shoes.html',
        mimeType: 'text/html',
        content: '<h1>Best trail running shoes for wide feet</h1>',
      },
      {
        filename: 'wide-fit-trail-shoes.json',
        mimeType: 'application/json',
        content: '{\n  "title": "Best trail running shoes for wide feet"\n}\n',
      },
    ],
  },
  'POST /api/articles/{articleId}/published-url': { ok: true },
  'POST /api/articles/{articleId}/refresh': { ok: true },

  'GET /api/products': {
    richness: { band: 'okay', productsMissingDetails: 6 },
    counts: { products: 40, families: 4 },
    merchantTasks: [
      {
        opportunityId: fixtureOpportunities[2]!.id,
        blockingTitle: 'Best trail shoes for wide feet',
        impact: 'high',
        products: [
          {
            id: 'trail-running-2',
            title: 'Trail Running 2',
            missingFields: ['material', 'weight_g'],
            shopifyAdminUrl: 'https://example.myshopify.com/admin/products/2',
          },
        ],
        completedAt: null,
      },
    ],
    products: [
      {
        id: 'trail-running-1',
        title: 'Trail Running 1',
        familyId: 'trail-running',
        factCount: 7,
        richnessBand: 'rich',
        missingFields: [],
        lastSyncedAt: NOW,
      },
    ],
    cursor: null,
  },
  'GET /api/products/families': {
    families: [
      {
        id: 'trail-running',
        label: 'Trail Running',
        memberCount: 12,
        axes: ['terrain', 'drop', 'width'],
        groupingSource: 'fact_clustering',
        lowConfidence: false,
      },
    ],
  },

  'GET /api/performance/overview': {
    connected: true,
    series: [
      { date: TODAY, clicks: 41, impressions: 1820 },
      // A gap renders as a gap, never as an interpolated line.
      { date: '2026-02-03', clicks: null, impressions: null },
    ],
    markers: [{ date: TODAY, kind: 'article_published', label: 'Wide-fit trail shoes' }],
    results: [
      {
        kind: 'article',
        id: articleFixture.id,
        title: articleFixture.title,
        clicks: 41,
        impressions: 1820,
        position: 12.4,
        trend: 'up',
        label: 'unrated',
        publishedViaOverride: false,
      },
    ],
  },
  'GET /api/performance/search-console': {
    rows: [
      {
        key: 'best trail running shoes',
        clicks: 210,
        impressions: 9402,
        ctr: 0.022,
        position: 7.3,
        deltaClicks: 18,
        deltaPosition: -0.4,
        pageType: 'collection',
        signals: [{ signalType: 'striking_distance', opportunityId: fixtureOpportunities[0]!.id }],
      },
    ],
    cursor: null,
  },

  'GET /api/notifications': {
    notifications: [
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        type: 'opportunities_ready',
        refs: { signalRunId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
        createdAt: NOW,
        seenAt: null,
        readAt: null,
      },
    ],
    unseenCount: 1,
  },
  'POST /api/notifications/seen': { ok: true },
  'POST /api/notifications/{notificationId}/read': { ok: true },
  'GET /api/attention': {
    items: [
      {
        kind: 'merchant_task',
        refs: { opportunityId: fixtureOpportunities[2]!.id },
        since: NOW,
      },
    ],
  },

  'POST /api/webhooks/stripe': { received: true },
  'POST /api/webhooks/shopify/{topic}': { received: true },
  'POST /api/webhooks/resend': { received: true },
}

function settingsFixture() {
  return {
    delivery: 'export',
    shopifyPublishAs: 'live',
    publishHour: 9,
    timezone: 'Europe/Copenhagen',
    draftReview: false,
    autoRepair: true,
    vacationMode: false,
    uiLanguage: null,
    emailArticlePublished: false,
    emailDigestFrequency: 'off',
  }
}

function ingestionFixture() {
  return {
    jobId: '77777777-7777-4777-8777-777777777777',
    status: 'running',
    startedAt: NOW,
    steps: [
      { step: 'detect', state: 'succeeded', startedAt: NOW, updatedAt: NOW, attempts: 1 },
      { step: 'catalog_sync', state: 'running', startedAt: NOW, updatedAt: NOW, attempts: 1 },
      { step: 'gsc_connect', state: 'skipped', startedAt: null, updatedAt: NOW, attempts: 0 },
    ],
  }
}

function keywordFixture() {
  return {
    id: '88888888-8888-4888-8888-888888888888',
    term: 'trail running shoes for wide feet',
    monthlySearchVolume: null,
    difficulty: null,
    source: 'manual',
    enrichmentState: 'pending',
  }
}

function profileFixture() {
  return {
    description: 'An outdoor retailer specialising in trail running and hiking footwear.',
    language: 'en',
    country: 'GB',
    audience: 'Recreational trail runners and hikers',
    tone: 'Practical, technical, no hype',
    topProducts: [
      {
        id: 'trail-running-1',
        title: 'Trail Running 1',
        imageUrl: null,
        source: 'orders_api',
        pinned: false,
        revenueBand: 'high',
      },
    ],
    keywords: [
      {
        ...keywordFixture(),
        monthlySearchVolume: 880,
        difficulty: 34,
        source: 'auto',
        enrichmentState: 'enriched',
      },
    ],
    competitors: [
      { id: '99999999-9999-4999-8999-999999999999', domain: 'competitor.example', source: 'auto' },
    ],
    competitorSuggestions: [{ domain: 'suggested.example', appearsInQueries: 8 }],
    families: [
      {
        id: 'trail-running',
        label: 'Trail Running',
        memberCount: 12,
        axes: ['terrain', 'drop', 'width'],
        groupingSource: 'fact_clustering',
        lowConfidence: false,
      },
    ],
    richness: { band: 'okay', productsMissingDetails: 6 },
    searchConsole: { connected: true, property: `sc-domain:${FIXTURE_DOMAIN}` },
    confirmed: false,
  }
}

/** Every route must have a fixture; the handler test asserts this and validates each. */
export function fixtureFor(route: Pick<RouteDefinition, 'method' | 'path'>): unknown {
  const key = `${route.method} ${route.path}`
  if (!(key in RESPONSE_FIXTURES)) {
    throw new Error(`No MSW fixture for ${key}. Every route needs one (build plan T0.7).`)
  }
  return RESPONSE_FIXTURES[key]
}

export { FIXTURE_ACCOUNT_ID, FIXTURE_DOMAIN, FIXTURE_RULES_VERSION }
