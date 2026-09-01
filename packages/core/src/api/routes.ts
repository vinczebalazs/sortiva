import type { z } from 'zod'
import { CONFLICT_CODES, type ConflictCode } from './errors'
import * as s from './schemas'

/**
 * Every `/api/*` route named in ui §1–§10 and tech §3, with its request and
 * response schemas.
 *
 * This table is the contract. The OpenAPI document is generated from it, the MSW
 * handlers are built from it, and `pnpm contracts:check` fails if the committed
 * OpenAPI has drifted — so there is one source of truth rather than two
 * descriptions that agree only while someone is watching.
 *
 * `/api/auth/*` is absent on purpose: Auth.js owns those routes and defines
 * their shapes (main §4.1).
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export interface RouteDefinition {
  readonly method: HttpMethod
  /** OpenAPI-style path, `{param}` for path parameters. */
  readonly path: string
  readonly summary: string
  /** Which spec section requires it. Evidence, not explanation. */
  readonly spec: string
  /**
   * `public` — unauthenticated (main §3.2's preview, the webhooks, health).
   * `session` — requires a session; `account_id` comes from it, never the body (tech §3).
   */
  readonly auth: 'public' | 'session'
  readonly query?: z.ZodType
  readonly body?: z.ZodType
  readonly response: z.ZodType
  readonly status?: number
  /**
   * tech §3 — guarded transitions return 409 with a machine-readable code. A
   * mutation that maps to a guarded transition must list the codes it can
   * return, so the UI knows which toasts to build.
   */
  readonly conflicts?: readonly ConflictCode[]
  /**
   * main §4.2, invariant 16 — billing state gates generation and publishing
   * only. **Read access is never revoked**, so no GET carries this.
   */
  readonly requiresEntitlement?: boolean
  /** main §3.2 — per-IP and global rate limits; the route can answer 429. */
  readonly rateLimited?: boolean
  /** Streams Server-Sent Events (tech §1.6); the response schema describes one event. */
  readonly sse?: boolean
}

export const ROUTES: readonly RouteDefinition[] = [
  // ── Health ────────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/health',
    summary: 'Liveness probe for the Railway health check.',
    spec: 'tech §2.1',
    auth: 'public',
    response: s.healthResponseSchema,
  },

  // ── Public preview (main §3) ──────────────────────────────────────────────
  {
    method: 'POST',
    path: '/api/preview',
    summary: 'Analyse a domain and return the business summary card.',
    spec: 'main §3.2',
    auth: 'public',
    body: s.previewRequestSchema,
    response: s.previewResponseSchema,
    rateLimited: true,
  },

  // ── Account, billing, settings (main §4, ui §9) ───────────────────────────
  {
    method: 'GET',
    path: '/api/account',
    summary: 'Session account: domain state, entitlement, connections, service status.',
    spec: 'main §4.1, §4.2; ui §1',
    auth: 'session',
    response: s.accountResponseSchema,
  },
  {
    method: 'GET',
    path: '/api/billing/plan',
    summary: 'The Pro plan card: live Stripe amounts, cap line, inclusions.',
    // ui §2.3 requires the price and a monthly/annual toggle on this screen, and
    // main §4.2 forbids hardcoding any amount — so the screen has to ask.
    // Added by card T1.2a under the founder's licence to re-freeze the frozen
    // route table; it is the one route that table gained.
    spec: 'main §4.2; ui §2.3',
    // Public: the plan screen is reachable before signup, and it exposes only
    // list prices Stripe Checkout would show anyway. No account row is read, so
    // there is nothing here to scope.
    auth: 'public',
    response: s.planResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/billing/checkout',
    summary: 'Create a Stripe Checkout session. We render no card form, ever.',
    spec: 'main §4.2; ui §2.3',
    auth: 'session',
    body: s.checkoutRequestSchema,
    response: s.redirectResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/billing/portal',
    summary: 'Create a Stripe Customer Portal link.',
    spec: 'main §4.2; ui §9.4',
    auth: 'session',
    response: s.redirectResponseSchema,
  },
  {
    method: 'GET',
    path: '/api/settings',
    summary: 'Every account setting the Settings screens expose.',
    spec: 'ui §9',
    auth: 'session',
    response: s.settingsSchema,
  },
  {
    method: 'PATCH',
    path: '/api/settings',
    summary: 'Update account settings.',
    spec: 'ui §9',
    auth: 'session',
    body: s.settingsPatchSchema,
    response: s.settingsSchema,
    conflicts: ['write_scope_required', 'target_blog_unresolved'],
  },
  {
    method: 'GET',
    path: '/api/settings/blogs',
    summary: 'Shopify blogs available as an auto-publish target.',
    spec: 'main §9.5; ui §9.1',
    auth: 'session',
    response: s.blogsResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/settings/blog',
    summary: 'Choose or create the target blog. Auto-publish cannot enable without one.',
    spec: 'main §9.5, invariant 21; ui §9.1',
    auth: 'session',
    body: s.selectBlogRequestSchema,
    response: s.okSchema,
    conflicts: ['write_scope_required'],
  },
  {
    method: 'POST',
    path: '/api/account/delete',
    summary: 'Delete the account: tokens revoked now, data within 30 days, domain released after 7.',
    spec: 'main §14.6; ui §9.4',
    auth: 'session',
    body: s.deleteAccountRequestSchema,
    response: s.okSchema,
  },

  // ── Domain claim (main §5, ui §3.1) ───────────────────────────────────────
  {
    method: 'POST',
    path: '/api/domain/claim',
    summary: 'Claim a domain at eTLD+1 and enqueue the ingestion run.',
    spec: 'main §2, §5, invariant 1; ui §3.1',
    auth: 'session',
    body: s.claimDomainRequestSchema,
    response: s.claimDomainResponseSchema,
    conflicts: ['domain_already_claimed'],
  },

  // ── Ingestion progress (main §14.3.1, ui §3.2) ────────────────────────────
  {
    method: 'GET',
    path: '/api/ingestion/status',
    summary: 'Current ingestion run and its steps. The 5s fallback for the SSE stream.',
    spec: 'main §14.3.1; ui §3.2; tech §1.6',
    auth: 'session',
    response: s.ingestionStatusResponseSchema,
  },
  {
    method: 'GET',
    path: '/api/ingestion/stream',
    summary: 'Server-sent stream of job_steps transitions for the active run.',
    spec: 'tech §1.6; ui §3.2',
    auth: 'session',
    response: s.ingestionStatusResponseSchema,
    sse: true,
  },

  // ── Shopify & Search Console connections (main §6.2, §6.7) ────────────────
  {
    method: 'POST',
    path: '/api/shopify/oauth/start',
    summary: 'Begin Shopify OAuth. Read scopes only at install (invariant 21).',
    spec: 'main §6.2; tech §4; ui §3.3',
    auth: 'session',
    response: s.redirectResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/gsc/oauth/start',
    summary: 'Begin Google OAuth for Search Console (webmasters.readonly).',
    spec: 'main §6.7, §12.2; ui §3.6',
    auth: 'session',
    response: s.redirectResponseSchema,
  },
  {
    method: 'GET',
    path: '/api/gsc/properties',
    summary: 'Properties the connected Google account can read, flagged for host match.',
    spec: 'main §12.2; ui §3.6',
    auth: 'session',
    response: s.gscPropertiesResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/gsc/property',
    summary: 'Select the Search Console property and enqueue the 16-month backfill.',
    spec: 'main §6.7, §12.2; ui §3.6',
    auth: 'session',
    body: s.selectGscPropertyRequestSchema,
    response: s.okSchema,
  },
  {
    method: 'POST',
    path: '/api/gsc/skip',
    summary: 'Skip Search Console. The run continues in Limited Intelligence mode.',
    spec: 'main §6.7, §7.11; ui §3.6',
    auth: 'session',
    response: s.okSchema,
  },

  // ── Store profile (main §6.8, ui §3.7 / §9.2) ─────────────────────────────
  {
    method: 'GET',
    path: '/api/profile',
    summary: 'The confirmation screen, and Settings → Store profile after it.',
    spec: 'main §6.8; ui §3.7, §9.2',
    auth: 'session',
    response: s.profileResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/profile/confirm',
    summary: 'Confirm the profile and start the first opportunity run.',
    spec: 'main §6.8, §6.9; ui §3.7',
    auth: 'session',
    body: s.confirmProfileRequestSchema,
    response: s.okSchema,
    conflicts: ['profile_already_confirmed'],
  },
  {
    method: 'POST',
    path: '/api/profile/keywords',
    summary: 'Add a keyword; enrichment runs job-side on the high-priority lane.',
    spec: 'main §6.6, §12.1; ui §3.7',
    auth: 'session',
    body: s.addKeywordRequestSchema,
    response: s.keywordSchema,
  },
  {
    method: 'DELETE',
    path: '/api/profile/keywords/{keywordId}',
    summary: 'Remove a keyword.',
    spec: 'main §6.6; ui §3.7',
    auth: 'session',
    response: s.okSchema,
  },
  {
    method: 'POST',
    path: '/api/profile/competitors',
    summary: 'Add a competitor. Capped at five in the API and the database.',
    spec: 'main §6.6, §7.2.1, invariant 5; ui §3.7',
    auth: 'session',
    body: s.addCompetitorRequestSchema,
    response: s.competitorSchema,
    conflicts: ['competitor_limit_reached', 'competitor_is_own_domain'],
  },
  {
    method: 'DELETE',
    path: '/api/profile/competitors/{competitorId}',
    summary: 'Remove a competitor.',
    spec: 'main §6.6; ui §3.7',
    auth: 'session',
    response: s.okSchema,
  },
  {
    method: 'POST',
    path: '/api/products/families/report',
    summary: 'Report a wrong grouping. Feedback only — families are not user-editable.',
    spec: 'main §6.4; ui §3.7, §7',
    auth: 'session',
    body: s.reportGroupingRequestSchema,
    response: s.okSchema,
  },

  // ── Opportunities (main §7, ui §5) ────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/opportunities',
    summary: 'The Opportunities list with its filters, counts and scan times.',
    spec: 'main §7; ui §5.1',
    auth: 'session',
    query: s.listOpportunitiesQuerySchema,
    response: s.listOpportunitiesResponseSchema,
  },
  {
    method: 'GET',
    path: '/api/opportunities/{opportunityId}',
    summary: 'The detail drawer: evidence, tasks, recommendation, history, outcome.',
    spec: 'main §7.6, §10.3; ui §5.3',
    auth: 'session',
    response: s.opportunityDetailResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/opportunities/{opportunityId}/schedule',
    summary: 'Put a CREATE or REFRESH opportunity on the calendar.',
    spec: 'main §7.9, §8.7; ui §5.4',
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
    path: '/api/opportunities/{opportunityId}/dismiss',
    summary: 'Dismiss an opportunity; it is never re-proposed for the same entity.',
    spec: 'main §7.9; ui §5.4',
    auth: 'session',
    response: s.okSchema,
    conflicts: ['opportunity_already_updated', 'opportunity_not_open'],
  },
  {
    method: 'POST',
    path: '/api/opportunities/{opportunityId}/restore',
    summary: 'Undo a dismissal.',
    spec: 'main §7.9; ui §5.4',
    auth: 'session',
    response: s.okSchema,
    conflicts: ['opportunity_already_updated'],
  },
  {
    method: 'POST',
    path: '/api/opportunities/{opportunityId}/recommendations',
    summary: 'Generate an OPTIMIZE recommendation. User-initiated, capped per day.',
    spec: 'main §10.2, §10.3; ui §5.4',
    auth: 'session',
    response: s.okSchema,
    conflicts: ['optimize_daily_cap_reached', 'opportunity_not_open', 'service_paused'],
    requiresEntitlement: true,
  },
  {
    method: 'POST',
    path: '/api/opportunities/{opportunityId}/tasks/{taskId}',
    summary: 'Mark an opportunity task applied or skipped.',
    spec: 'main §10.4; ui §5.3',
    auth: 'session',
    body: s.markTaskAppliedRequestSchema,
    response: s.okSchema,
    conflicts: ['opportunity_already_updated'],
  },

  // ── Calendar (main §8.7, ui §6.1) ─────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/calendar',
    summary: 'Planned and past topics across a date range, plus the paused ribbon state.',
    spec: 'main §8.7; ui §6.1',
    auth: 'session',
    query: s.calendarQuerySchema,
    response: s.calendarResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/calendar/topics',
    summary: 'Add a topic by hand. Still passes Gate 1, and may convert to an OPTIMIZE.',
    spec: 'main §8.7, §7.7, invariant 6; ui §6.1',
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
    spec: 'main §8.7, invariant 15; ui §6.1',
    auth: 'session',
    response: s.okSchema,
    conflicts: ['topic_already_published'],
  },
  {
    method: 'POST',
    path: '/api/calendar/topics/{topicId}/move',
    summary: 'Move a planned topic to another future date.',
    spec: 'main §8.7; ui §6.1',
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
    spec: 'main §8.7; ui §6.1',
    auth: 'session',
    body: s.pinTopicRequestSchema,
    response: s.topicSchema,
    conflicts: ['topic_already_published'],
  },

  // ── Articles (main §9, ui §6.2–6.3) ───────────────────────────────────────
  {
    method: 'GET',
    path: '/api/articles',
    summary: 'The articles library.',
    spec: 'ui §6.2',
    auth: 'session',
    query: s.listArticlesQuerySchema,
    response: s.listArticlesResponseSchema,
  },
  {
    method: 'GET',
    path: '/api/articles/{articleId}',
    summary: 'Read-only article detail with its quality report. There is no editor.',
    spec: 'main §9.3; ui §6.3',
    auth: 'session',
    response: s.articleDetailResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/articles/{articleId}/approve',
    summary: 'Approve an in-review draft and publish it.',
    spec: 'main §9.3; ui §6.3',
    auth: 'session',
    response: s.okSchema,
    conflicts: ['article_not_in_review', 'article_already_published', 'service_paused'],
    requiresEntitlement: true,
  },
  {
    method: 'POST',
    path: '/api/articles/{articleId}/discard',
    summary: 'Discard an in-review draft.',
    spec: 'main §9.3; ui §6.3',
    auth: 'session',
    response: s.okSchema,
    conflicts: ['article_not_in_review'],
  },
  {
    method: 'POST',
    path: '/api/articles/{articleId}/publish-anyway',
    summary: 'Publish a gate-rejected draft. Carries published_via_override thereafter.',
    spec: 'main §8.6, invariant 12; ui §6.3',
    auth: 'session',
    body: s.overridePublishRequestSchema,
    response: s.okSchema,
    conflicts: ['article_not_rejected', 'article_already_published'],
    requiresEntitlement: true,
  },
  {
    method: 'POST',
    path: '/api/articles/{articleId}/published-url',
    summary: 'Confirm the URL an exported article was published at, for attribution.',
    spec: 'main §9.4, §12.2; ui §6.2',
    auth: 'session',
    body: s.confirmPublishedUrlRequestSchema,
    response: s.okSchema,
  },
  {
    method: 'POST',
    path: '/api/articles/{articleId}/refresh',
    summary: 'Request a refresh; subject to the refresh cooldown.',
    spec: 'main §9.6.5; ui §6.3',
    auth: 'session',
    response: s.okSchema,
    conflicts: ['refresh_within_cooldown'],
    requiresEntitlement: true,
  },

  // ── Products (ui §7) ──────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/products',
    summary: 'Richness, merchant tasks from open HOLDs, and the product table.',
    spec: 'main §6.3, §7.4; ui §7',
    auth: 'session',
    response: s.productsResponseSchema,
  },
  {
    method: 'GET',
    path: '/api/products/families',
    summary: 'The read-only family list with its differentiation axes.',
    spec: 'main §6.4; ui §7',
    auth: 'session',
    response: s.familiesResponseSchema,
  },

  // ── Performance (main §9.6, §12.2, ui §8) ─────────────────────────────────
  {
    method: 'GET',
    path: '/api/performance/overview',
    summary: 'The headline chart, its markers, and the results table.',
    spec: 'main §9.6; ui §8.1',
    auth: 'session',
    response: s.performanceOverviewResponseSchema,
  },
  {
    method: 'GET',
    path: '/api/performance/search-console',
    summary: 'Query and page tables with signal badges linking into Opportunities.',
    spec: 'main §12.2; ui §8.2',
    auth: 'session',
    query: s.searchConsoleQuerySchema,
    response: s.searchConsoleResponseSchema,
  },

  // ── Notifications (tech §1, ui §10) ───────────────────────────────────────
  {
    method: 'GET',
    path: '/api/notifications',
    summary: 'Bell list and unseen count. Polled every 30s.',
    spec: 'tech §1.2, §1.6; ui §10',
    auth: 'session',
    query: s.notificationsQuerySchema,
    response: s.notificationsResponseSchema,
  },
  {
    method: 'POST',
    path: '/api/notifications/seen',
    summary: 'Clear the badge. Opening the bell marks everything seen.',
    spec: 'tech §1.2',
    auth: 'session',
    response: s.okSchema,
  },
  {
    method: 'POST',
    path: '/api/notifications/{notificationId}/read',
    summary: 'Mark one notification read.',
    spec: 'tech §1.2',
    auth: 'session',
    response: s.okSchema,
  },
  {
    method: 'GET',
    path: '/api/attention',
    summary: 'The dashboard attention list — a live query, never stored rows.',
    spec: 'tech §1.1; ui §4',
    auth: 'session',
    response: s.attentionResponseSchema,
  },

  // ── Webhooks (tech §3, main §14.3.8) ──────────────────────────────────────
  {
    method: 'POST',
    path: '/api/webhooks/stripe',
    summary: 'Verify the signature, insert-or-ignore by event id, return 200, process async.',
    spec: 'main §4.2, §14.3.8; tech §3',
    auth: 'public',
    response: s.webhookAckSchema,
  },
  {
    method: 'POST',
    path: '/api/webhooks/shopify/{topic}',
    summary: 'Verify HMAC before touching the body, dedupe by webhook id, return 200 under 5s.',
    spec: 'main §14.1, §14.3.8; tech §3',
    auth: 'public',
    response: s.webhookAckSchema,
  },
  {
    method: 'POST',
    path: '/api/webhooks/resend',
    summary: 'Bounce and complaint events into email_suppressions; delivered into email_sends.',
    spec: 'tech §1.4, §1.5',
    auth: 'public',
    response: s.webhookAckSchema,
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
