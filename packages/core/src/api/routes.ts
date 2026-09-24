import type { z } from 'zod'
import { CONFLICT_CODES, type ConflictCode } from './errors'
import * as s from './schemas'

/**
 * Every `/api/*` route the product exposes, with its request and response
 * schemas.
 *
 * This table is the contract. The OpenAPI document is generated from it, the MSW
 * handlers are built from it, and `pnpm contracts:check` fails if the committed
 * OpenAPI has drifted — so there is one source of truth rather than two
 * descriptions that agree only while someone is watching.
 *
 * `/api/auth/*` is absent on purpose: Auth.js owns those routes and defines
 * their shapes.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export interface RouteDefinition {
  readonly method: HttpMethod
  /** OpenAPI-style path, `{param}` for path parameters. */
  readonly path: string
  readonly summary: string
  /**
   * `public` — unauthenticated: the pre-signup preview, the webhooks, health.
   * `session` — requires a session, and `account_id` is resolved from it rather
   * than read from the request, so no caller can name someone else's account.
   */
  readonly auth: 'public' | 'session'
  readonly query?: z.ZodType
  readonly body?: z.ZodType
  readonly response: z.ZodType
  readonly status?: number
  /**
   * A state change that can lose a race returns 409 with a machine-readable
   * code rather than a message. Every such mutation lists the codes it can
   * return, so the UI knows which outcomes it has to have copy for.
   */
  readonly conflicts?: readonly ConflictCode[]
  /**
   * Billing state gates generation and publishing only. **Read access is never
   * revoked** — a lapsed subscriber can still see everything we made for them —
   * so no GET carries this.
   */
  readonly requiresEntitlement?: boolean
  /** Carries per-IP and global rate limits, so the route can answer 429. */
  readonly rateLimited?: boolean
  /** Streams Server-Sent Events; the response schema describes one event, not the stream. */
  readonly sse?: boolean
}

export const ROUTES: readonly RouteDefinition[] = [
  // ── Health ────────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/health',
    summary: 'Liveness probe for the Railway health check.',
    auth: 'public',
    response: s.healthResponseSchema,
  },

  // ── Public preview ────────────────────────────────────────────────────────
  {
    method: 'POST',
    path: '/api/preview',
    summary: 'Analyse a domain and return the business summary card.',
    auth: 'public',
    body: s.previewRequestSchema,
    response: s.previewResponseSchema,
    rateLimited: true,
  },

  // ── Account and settings ──────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/account',
    summary: 'Session account: domain state, entitlement, connections, service status.',
    auth: 'session',
    response: s.accountResponseSchema,
  },
  {
    method: 'GET',
    path: '/api/settings',
    summary: 'Every account setting the Settings screens expose.',
    auth: 'session',
    response: s.settingsSchema,
  },
  {
    method: 'PATCH',
    path: '/api/settings',
    summary: 'Update account settings.',
    auth: 'session',
    body: s.settingsPatchSchema,
    response: s.settingsSchema,
    conflicts: ['write_scope_required', 'target_blog_unresolved'],
  },
  {
    method: 'GET',
    path: '/api/publish/blogs',
    summary: 'Shopify blogs available as an auto-publish target.',
    auth: 'session',
    response: s.blogsResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/publish/target',
    summary: 'Choose or create the target blog. Auto-publish cannot enable without one.',
    auth: 'session',
    body: s.selectBlogRequestSchema,
    response: s.selectBlogResponseSchema,
    conflicts: ['write_scope_required'],
  },
  {
    method: 'POST',
    path: '/api/publish/mode',
    summary: 'Switch auto-publish on or off, and choose whether posts go live or wait as drafts.',
    auth: 'session',
    body: s.setDeliveryModeRequestSchema,
    response: s.setDeliveryModeResponseSchema,
    conflicts: ['write_scope_required', 'target_blog_unresolved'],
  },
  {
    method: 'POST',
    path: '/api/publish/grant/start',
    summary: 'Begin the second Shopify grant, for permission to write. Never asked for at install.',
    auth: 'session',
    response: s.redirectResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/account/delete',
    summary: 'Delete the account: tokens revoked now, data within 30 days, domain released after 7.',
    auth: 'session',
    body: s.deleteAccountRequestSchema,
    response: s.okSchema,
  },

  // ── Domain claim ──────────────────────────────────────────────────────────
  {
    method: 'POST',
    path: '/api/domain/claim',
    summary: 'Claim a domain at eTLD+1 and enqueue the ingestion run.',
    auth: 'session',
    body: s.claimDomainRequestSchema,
    response: s.claimDomainResponseSchema,
    conflicts: ['domain_already_claimed'],
  },

  // ── Ingestion progress ────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/ingestion/status',
    summary: 'Current ingestion run and its steps. The 5s fallback for the SSE stream.',
    auth: 'session',
    response: s.ingestionStatusResponseSchema,
  },
  {
    method: 'GET',
    path: '/api/ingestion/stream',
    summary: 'Server-sent stream of job_steps transitions for the active run.',
    auth: 'session',
    response: s.ingestionStatusResponseSchema,
    sse: true,
  },

  // ── Shopify & Search Console connections ──────────────────────────────────
  {
    method: 'POST',
    path: '/api/shopify/oauth/start',
    summary: 'Begin Shopify OAuth. Read scopes only at install (invariant 21).',
    auth: 'session',
    response: s.redirectResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/gsc/oauth/start',
    summary: 'Begin Google OAuth for Search Console (webmasters.readonly).',
    auth: 'session',
    response: s.redirectResponseSchema,
  },
  {
    method: 'GET',
    path: '/api/gsc/properties',
    summary: 'Properties the connected Google account can read, flagged for host match.',
    auth: 'session',
    response: s.gscPropertiesResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/gsc/property',
    summary: 'Select the Search Console property and enqueue the 16-month backfill.',
    auth: 'session',
    body: s.selectGscPropertyRequestSchema,
    response: s.okSchema,
  },
  {
    method: 'POST',
    path: '/api/gsc/skip',
    summary: 'Skip Search Console. The run continues in Limited Intelligence mode.',
    auth: 'session',
    response: s.okSchema,
  },

  // ── Store profile ─────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/profile',
    summary: 'The confirmation screen, and Settings → Store profile after it.',
    auth: 'session',
    response: s.profileResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/profile/confirm',
    summary: 'Confirm the profile and start the first opportunity run.',
    auth: 'session',
    body: s.confirmProfileRequestSchema,
    response: s.okSchema,
    conflicts: ['profile_already_confirmed'],
  },
  {
    method: 'POST',
    path: '/api/profile/keywords',
    summary: 'Add a keyword; enrichment runs job-side on the high-priority lane.',
    auth: 'session',
    body: s.addKeywordRequestSchema,
    response: s.keywordSchema,
  },
  {
    method: 'DELETE',
    path: '/api/profile/keywords/{keywordId}',
    summary: 'Remove a keyword.',
    auth: 'session',
    response: s.okSchema,
  },
  {
    method: 'POST',
    path: '/api/profile/competitors',
    summary: 'Add a competitor. Capped at five in the API and the database.',
    auth: 'session',
    body: s.addCompetitorRequestSchema,
    response: s.competitorSchema,
    conflicts: ['competitor_limit_reached', 'competitor_is_own_domain'],
  },
  {
    method: 'DELETE',
    path: '/api/profile/competitors/{competitorId}',
    summary: 'Remove a competitor.',
    auth: 'session',
    response: s.okSchema,
  },
  {
    method: 'POST',
    path: '/api/products/families/report',
    summary: 'Report a wrong grouping. Feedback only — families are not user-editable.',
    auth: 'session',
    body: s.reportGroupingRequestSchema,
    response: s.okSchema,
  },

  // ── Opportunities ─────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/opportunities',
    summary: 'The Opportunities list with its filters, counts and scan times.',
    auth: 'session',
    query: s.listOpportunitiesQuerySchema,
    response: s.listOpportunitiesResponseSchema,
  },
  {
    method: 'GET',
    path: '/api/opportunities/scan-status',
    summary: 'Whether the opportunity scan is still running, and its counts once it is not.',
    auth: 'session',
    response: s.scanStatusResponseSchema,
  },
  {
    method: 'GET',
    path: '/api/opportunities/scan-stream',
    summary: 'The same scan progress as a stream, which closes itself when the run ends.',
    auth: 'session',
    response: s.scanStatusResponseSchema,
    sse: true,
  },

  // These two come before `/api/opportunities/{id}` deliberately. A generated
  // client that matches in table order — the frontend's mock server does —
  // would otherwise read "scan-status" as an opportunity id and answer the
  // wrong shape. Next.js itself prefers the fixed segment, so only order-
  // sensitive consumers are at risk, and they are the reason this stays put.
  {
    method: 'GET',
    path: '/api/opportunities/{id}',
    summary: 'The detail drawer: evidence, tasks, recommendation, history, outcome.',
    auth: 'session',
    response: s.opportunityDetailResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/opportunities/{id}/schedule',
    summary: 'Put a CREATE or REFRESH opportunity on the calendar.',
    auth: 'session',
    body: s.scheduleOpportunityRequestSchema,
    response: s.scheduleOpportunityResponseSchema,
    conflicts: [
      'opportunity_already_updated',
      'opportunity_not_open',
      'calendar_day_occupied',
      'calendar_date_in_past',
      'topic_pinned',
    ],
    requiresEntitlement: true,
  },
  {
    method: 'POST',
    path: '/api/opportunities/{id}/dismiss',
    summary: 'Dismiss an opportunity; it is never re-proposed for the same entity.',
    auth: 'session',
    response: s.okSchema,
    conflicts: ['opportunity_already_updated', 'opportunity_not_open'],
  },
  {
    method: 'POST',
    path: '/api/opportunities/{id}/undismiss',
    summary: 'Undo a dismissal.',
    auth: 'session',
    response: s.okSchema,
    conflicts: ['opportunity_already_updated'],
  },
  // ── Recommendations ───────────────────────────────────────────────────────
  // Grouped by what they are rather than under the opportunity they belong to,
  // which is where an earlier version of this table put them.
  {
    method: 'POST',
    path: '/api/recommendations',
    summary: 'Generate an OPTIMIZE recommendation for an opportunity. User-initiated, capped per day.',
    auth: 'session',
    body: s.generateRecommendationRequestSchema,
    response: s.generateRecommendationResponseSchema,
    conflicts: [
      'optimize_daily_cap_reached',
      'opportunity_not_open',
      'optimize_no_target_query',
      'optimize_page_gone',
      'service_paused',
    ],
    requiresEntitlement: true,
  },
  {
    method: 'GET',
    path: '/api/recommendations',
    summary: 'The recommendation for an opportunity, its tasks, and whether the page already looks changed.',
    auth: 'session',
    query: s.readRecommendationQuerySchema,
    response: s.readRecommendationResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/recommendations/{id}/apply',
    summary: 'Mark one task or the whole recommendation applied. The whole one starts the outcome clock.',
    auth: 'session',
    body: s.applyRecommendationRequestSchema,
    response: s.applyRecommendationResponseSchema,
    conflicts: ['opportunity_already_updated'],
  },
  {
    method: 'POST',
    path: '/api/recommendations/{id}/skip',
    summary: 'Record that the merchant declined one task. Never counted as applied.',
    auth: 'session',
    body: s.skipTaskRequestSchema,
    response: s.skipTaskResponseSchema,
    conflicts: ['opportunity_already_updated'],
  },

  // ── Calendar ──────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/calendar',
    summary: 'Planned and past topics across a date range, plus the paused ribbon state.',
    auth: 'session',
    query: s.calendarQuerySchema,
    response: s.calendarResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/calendar/topics',
    summary: 'Add a topic by hand. Still passes Gate 1, and may convert to an OPTIMIZE.',
    auth: 'session',
    body: s.addTopicRequestSchema,
    response: s.addTopicResponseSchema,
    conflicts: ['calendar_day_occupied', 'calendar_date_in_past'],
    requiresEntitlement: true,
  },
  {
    method: 'POST',
    path: '/api/calendar/topics/{topicId}/veto',
    summary: 'Veto a topic. After dequeue this cancels publication, not the cost.',
    auth: 'session',
    response: s.okSchema,
    conflicts: ['topic_already_published'],
  },
  {
    method: 'POST',
    path: '/api/calendar/topics/{topicId}/move',
    summary: 'Move a planned topic to another future date.',
    auth: 'session',
    body: s.moveTopicRequestSchema,
    response: s.topicSchema,
    conflicts: [
      'topic_already_generating',
      'topic_already_published',
      'topic_pinned',
      'calendar_date_in_past',
    ],
  },
  {
    method: 'POST',
    path: '/api/calendar/topics/{topicId}/pin',
    summary: 'Pin or unpin a topic. Replenishment never moves a pinned topic.',
    auth: 'session',
    body: s.pinTopicRequestSchema,
    response: s.topicSchema,
    conflicts: ['topic_already_published'],
  },

  // ── Articles ──────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/articles',
    summary: 'The articles library.',
    auth: 'session',
    query: s.listArticlesQuerySchema,
    response: s.listArticlesResponseSchema,
  },
  {
    method: 'GET',
    path: '/api/articles/{articleId}',
    summary: 'Read-only article detail with its quality report. There is no editor.',
    auth: 'session',
    response: s.articleDetailResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/articles/{articleId}/approve',
    summary: 'Approve an in-review draft and publish it.',
    auth: 'session',
    response: s.okSchema,
    conflicts: ['article_not_in_review', 'article_already_published', 'service_paused'],
    requiresEntitlement: true,
  },
  {
    method: 'POST',
    path: '/api/articles/{articleId}/discard',
    summary: 'Discard an in-review draft.',
    auth: 'session',
    response: s.okSchema,
    conflicts: ['article_not_in_review'],
  },
  {
    method: 'POST',
    path: '/api/articles/{articleId}/publish-anyway',
    summary: 'Publish a gate-rejected draft. Carries published_via_override thereafter.',
    auth: 'session',
    body: s.overridePublishRequestSchema,
    response: s.okSchema,
    conflicts: ['article_not_rejected', 'article_already_published'],
    requiresEntitlement: true,
  },
  {
    method: 'GET',
    path: '/api/articles/{articleId}/export',
    summary: 'The article as Markdown and HTML with its metadata, priced from the store as it is now.',
    auth: 'session',
    // Its 409 — the article names a product the store no longer sells, so
    // handing the file over would publish a hole — carries an error class in
    // the generic envelope rather than a code from the conflict enum, the same
    // way its 404 does. Nothing here is a lost race, which is what that enum is
    // for.
    response: s.articleExportResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/articles/{articleId}/published-url',
    summary: 'Confirm the URL an exported article was published at, for attribution.',
    auth: 'session',
    body: s.confirmPublishedUrlRequestSchema,
    response: s.okSchema,
  },
  {
    method: 'POST',
    path: '/api/articles/{articleId}/refresh',
    summary: 'Request a refresh; subject to the refresh cooldown.',
    auth: 'session',
    response: s.okSchema,
    conflicts: ['refresh_within_cooldown'],
    requiresEntitlement: true,
  },

  // ── Products ──────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/products',
    summary: 'Richness, merchant tasks from open HOLDs, and the product table.',
    auth: 'session',
    response: s.productsResponseSchema,
  },
  {
    method: 'GET',
    path: '/api/products/families',
    summary: 'The read-only family list with its differentiation axes.',
    auth: 'session',
    response: s.familiesResponseSchema,
  },

  // ── Performance ───────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/performance/overview',
    summary: 'The headline chart, its markers, and the results table.',
    auth: 'session',
    response: s.performanceOverviewResponseSchema,
  },
  {
    method: 'GET',
    path: '/api/performance/search-console',
    summary: 'Query and page tables with signal badges linking into Opportunities.',
    auth: 'session',
    query: s.searchConsoleQuerySchema,
    response: s.searchConsoleResponseSchema,
  },

  // ── Notifications ─────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/notifications',
    summary: 'Bell list and unseen count. Polled every 30s.',
    auth: 'session',
    query: s.notificationsQuerySchema,
    response: s.notificationsResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/notifications/seen',
    summary: 'Clear the badge. Opening the bell marks everything seen.',
    auth: 'session',
    response: s.okSchema,
  },
  {
    method: 'POST',
    path: '/api/notifications/{notificationId}/read',
    summary: 'Mark one notification read.',
    auth: 'session',
    response: s.okSchema,
  },
  {
    method: 'GET',
    path: '/api/attention',
    summary: 'The dashboard attention list — a live query, never stored rows.',
    auth: 'session',
    response: s.attentionResponseSchema,
  },

  // ── Webhooks ──────────────────────────────────────────────────────────────
  {
    method: 'POST',
    path: '/api/webhooks/shopify/{topic}',
    summary: 'Verify HMAC before touching the body, dedupe by webhook id, return 200 under 5s.',
    auth: 'public',
    response: s.webhookAckSchema,
  },
  {
    method: 'POST',
    path: '/api/webhooks/resend',
    summary: 'Bounce and complaint events into email_suppressions; delivered into email_sends.',
    auth: 'public',
    response: s.webhookAckSchema,
  },
]

/**
 * Endpoints that exist on disk and are deliberately outside this table.
 *
 * The table describes JSON request and response shapes. These seven answer with
 * a redirect, a rendered page, or a file, so giving each a zod response schema
 * would state something untrue in order to be complete. They are listed rather
 * than merely absent because "not in the table" and "nobody built it" looked
 * identical for the whole build, and a check comparing the table to the routes
 * on disk needs to be able to tell them apart.
 *
 * Adding a path here is the decision this list exists to force into the open:
 * it says *this is not JSON*, never *this has no contract yet*.
 */
export const UNCONTRACTED_ROUTES: readonly { path: string; why: string }[] = [
  {
    path: '/api/auth/*',
    why: 'Auth.js owns these routes and defines their shapes.',
  },
  {
    path: 'GET /api/shopify/oauth/callback',
    why: 'Shopify redirects the browser here; the answer is a redirect onwards, not a payload.',
  },
  {
    path: 'GET /api/gsc/oauth/callback',
    why: 'Google redirects the browser here; the answer is a redirect onwards, not a payload.',
  },
  {
    path: 'GET /api/publish/grant/callback',
    why: 'Where Shopify returns from the second, write-permission grant. A redirect, not a payload.',
  },
  {
    path: 'GET /api/notifications/unsubscribe',
    why: 'The one-click unsubscribe link in an email. Renders a page for a person, not JSON for a screen.',
  },
  {
    path: 'POST /api/notifications/unsubscribe',
    why: 'The same link, for mail clients that confirm an unsubscribe with a POST.',
  },
  {
    path: 'GET /api/recommendations/{id}/download',
    why: 'Answers with the document itself as Markdown or HTML, as an attachment.',
  },
]

/** Every conflict code some route can actually return. */
export function declaredConflictCodes(): readonly ConflictCode[] {
  const used = new Set<ConflictCode>()
  for (const route of ROUTES) {
    for (const code of route.conflicts ?? []) used.add(code)
  }
  return [...used].sort()
}

/** Codes in the enum that no route returns — dead contract surface. */
export function unusedConflictCodes(): readonly ConflictCode[] {
  const used = new Set(declaredConflictCodes())
  return CONFLICT_CODES.filter((code) => !used.has(code))
}

export function routeKey(route: Pick<RouteDefinition, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`
}

export function findRoute(method: HttpMethod, path: string): RouteDefinition | undefined {
  return ROUTES.find((r) => r.method === method && r.path === path)
}
