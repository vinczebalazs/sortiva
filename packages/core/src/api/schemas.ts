import { z } from 'zod'
import {
  CONFIDENCE_BANDS,
  IMPACT_BANDS,
  INTENT_CLASSES,
  NOTIFICATION_TYPES,
  OPPORTUNITY_ACTIONS,
  OPPORTUNITY_STATUSES,
} from '../contracts/opportunities'

/**
 * The request and response shapes for every `/api/*` route (ui §1–§10, tech §3).
 * These are the single source of truth: the OpenAPI document is generated from
 * them, the MSW handlers validate against them, and route handlers parse with
 * them (CLAUDE.md: "parse → call core → serialise").
 *
 * Two product rules are enforced in the schema itself rather than left to each
 * screen:
 *
 * - **No denominators** (invariant 23, main §8.6, ui §4): count fields are bare
 *   numbers. There is no `of` or `target` field anywhere for a UI to render
 *   "3 of 30" from, because the cap is a ceiling and not a promise.
 * - **Every why-line is a template key plus params** (invariant 8, main §7.1):
 *   no response carries rendered prose for a reason. The renderer lives in
 *   `packages/ui`, and an LLM never touches it.
 */

// ── Shared primitives ────────────────────────────────────────────────────────

export const uuidSchema = z.string().uuid()
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
export const isoDateTimeSchema = z.string().datetime()

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

export const okSchema = z.object({ ok: z.literal(true) })

/** main §7.1, invariant 8 — the why-line renders from these, never from an LLM. */
export const whyLineSchema = z.object({
  templateKey: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
})

export const evidenceFactSchema = z.object({
  key: z.string(),
  value: z.union([z.string(), z.number()]),
  /** main §7.6 — source and window per fact; the card renders them. */
  source: z.string(),
  window: z.string().optional(),
  fetchedAt: isoDateTimeSchema,
})

export const entityRefSchema = z.object({
  kind: z.enum(['query_cluster', 'page', 'product', 'family', 'article']),
  id: z.string(),
  label: z.string(),
})

// ── Health ───────────────────────────────────────────────────────────────────

export const healthResponseSchema = z.object({ ok: z.literal(true) })

// ── Preview (main §3) ────────────────────────────────────────────────────────

export const previewRequestSchema = z.object({
  url: z.string().min(1),
  /** main §3.2 — verified server-side before any fetch happens. */
  turnstileToken: z.string().min(1),
})

export const previewResponseSchema = z.object({
  domain: z.string(),
  /** The Haiku 2–3 sentence summary, or null on the graceful generic card. */
  summary: z.string().nullable(),
  /** main §3.2 — a cache hit skips the scrape and the LLM entirely. */
  cacheHit: z.boolean(),
  /**
   * True when the scrape failed or the preview cost trip is active (main §14.5):
   * the UI renders the generic card, never an error state.
   */
  generic: z.boolean(),
})

// ── Account, billing, settings (main §4, ui §9) ──────────────────────────────

export const domainStateSchema = z.enum([
  'ingesting',
  'awaiting_shopify_auth',
  'needs_confirmation',
  'ready_for_planning',
  'unsupported',
])

export const accountResponseSchema = z.object({
  accountId: uuidSchema,
  email: z.string().email(),
  domain: z
    .object({ normalized: z.string(), state: domainStateSchema, platform: z.string().nullable() })
    .nullable(),
  /** main §4.2, invariant 16 — read from the local row only; never a Stripe call. */
  subscription: z.object({
    // `incomplete` — the first payment is still being authorised — is a fifth
    // status added by card T1.2a; see `packages/db/src/schema/enums.ts`. Like
    // `incomplete_expired` it is not entitled, so no consumer's gating changes.
    status: z.enum(['active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'none']),
    cancelAtPeriodEnd: z.boolean(),
    currentPeriodEnd: isoDateTimeSchema.nullable(),
  }),
  /** main §7.11 — no Search Console connected. */
  limitedIntelligence: z.boolean(),
  connections: z.object({
    shopify: z.enum(['none', 'read', 'read_write', 'broken']),
    searchConsole: z.enum(['none', 'connected', 'broken']),
    lastScanAt: isoDateTimeSchema.nullable(),
  }),
  /** main §14.5 — a kill switch is active; the UI renders the outage copy. */
  servicePaused: z.boolean(),
})

export const checkoutRequestSchema = z.object({ interval: z.enum(['monthly', 'annual']) })
export const redirectResponseSchema = z.object({ url: z.string().url() })

/**
 * ui §2.3's plan card: the price, the monthly/annual toggle, the verbatim cap
 * line and the inclusions.
 *
 * Amounts come from Stripe on every response (main §4.2 — "amounts live in
 * Stripe only — the app never hardcodes a dollar amount"), in minor units with
 * their currency, so the client formats and the API bakes in no locale. The
 * −20% annual saving is not a field: it is whatever the two amounts say it is,
 * which is the point of reading them from Stripe.
 */
export const planResponseSchema = z.object({
  planKey: z.literal('pro'),
  name: z.string(),
  /** main Appendix A, verbatim. Invariant 23 — never rendered with a denominator. */
  capLine: z.string(),
  inclusions: z.array(z.string()),
  cancelAnytime: z.string(),
  /** main §14.6 — the three cancellation facts, stated wherever cancellation is offered. */
  cancellationFacts: z.array(z.string()),
  prices: z.array(
    z.object({
      interval: z.enum(['monthly', 'annual']),
      priceId: z.string(),
      /** Cents, or the currency's smallest unit. Null for a metered price. */
      unitAmountMinor: z.number().int().nullable(),
      /** ISO 4217, lower-case, as Stripe returns it. */
      currency: z.string(),
    }),
  ),
})

export const settingsSchema = z.object({
  /** main §9.5 — export is the default; auto-publish is a second consent. */
  delivery: z.enum(['export', 'auto']),
  shopifyPublishAs: z.enum(['live', 'draft']),
  publishHour: z.number().int().min(0).max(23),
  timezone: z.string(),
  draftReview: z.boolean(),
  autoRepair: z.boolean(),
  vacationMode: z.boolean(),
  uiLanguage: z.string().nullable(),
  /** ui §9.4, tech §1.3 — only the opt-in rows are toggleable. */
  emailArticlePublished: z.boolean(),
  emailDigestFrequency: z.enum(['off', 'daily', 'weekly']),
})

export const settingsPatchSchema = settingsSchema.partial()

export const blogsResponseSchema = z.object({
  blogs: z.array(z.object({ id: z.string(), title: z.string(), handle: z.string() })),
})

export const selectBlogRequestSchema = z.object({
  blogId: z.string().optional(),
  /** ui §9.1 — "or 'create a blog named ___' one-click". */
  createNamed: z.string().optional(),
})

export const deleteAccountRequestSchema = z.object({
  /** ui §9.4 — type-to-confirm. */
  confirmation: z.literal('DELETE'),
})

// ── Domain claim (main §5, ui §3.1) ──────────────────────────────────────────

export const claimDomainRequestSchema = z.object({ domain: z.string().min(1) })

export const claimDomainResponseSchema = z.object({
  normalized: z.string(),
  state: domainStateSchema,
  /** main §5 — the claim enqueues the ingestion run. */
  ingestionJobId: uuidSchema,
})

// ── Ingestion progress (main §14.3.1, ui §3.2) ───────────────────────────────

export const jobStepSchema = z.object({
  step: z.enum([
    'detect',
    'oauth_wait',
    'catalog_sync',
    'distill',
    'family_group',
    'persona',
    'keywords_competitors',
    'gsc_connect',
    'awaiting_confirmation',
  ]),
  state: z.enum(['pending', 'running', 'succeeded', 'failed_retryable', 'failed_terminal', 'skipped']),
  startedAt: isoDateTimeSchema.nullable(),
  updatedAt: isoDateTimeSchema,
  attempts: z.number().int().min(0),
})

export const ingestionStatusResponseSchema = z.object({
  jobId: uuidSchema,
  status: z.enum(['running', 'succeeded', 'failed', 'abandoned']),
  steps: z.array(jobStepSchema),
  /** ui §3.2 — "show elapsed time on the active step after 60s". */
  startedAt: isoDateTimeSchema,
})

// ── Search Console (main §6.7, §12.2, ui §3.6) ───────────────────────────────

export const gscPropertiesResponseSchema = z.object({
  properties: z.array(
    z.object({
      siteUrl: z.string(),
      permissionLevel: z.string(),
      /** ui §3.6 — inline validation for host mismatch with the claimed domain. */
      matchesClaimedDomain: z.boolean(),
    }),
  ),
})

export const selectGscPropertyRequestSchema = z.object({ siteUrl: z.string().min(1) })

// ── Store profile / confirmation (main §6.8, ui §3.7) ────────────────────────

export const keywordSchema = z.object({
  id: uuidSchema,
  term: z.string(),
  /** Null while enrichment is pending — ui §3.7 renders a skeleton chip. */
  monthlySearchVolume: z.number().int().nullable(),
  difficulty: z.number().nullable(),
  source: z.enum(['auto', 'manual']),
  enrichmentState: z.enum(['pending', 'enriched', 'failed']),
})

export const competitorSchema = z.object({
  id: uuidSchema,
  domain: z.string(),
  source: z.enum(['auto', 'manual']),
})

/** main §7.2.1, invariant 5 — SERP domains are suggested, never auto-added. */
export const competitorSuggestionSchema = z.object({
  domain: z.string(),
  appearsInQueries: z.number().int(),
})

export const topProductSchema = z.object({
  id: z.string(),
  title: z.string(),
  imageUrl: z.string().nullable(),
  source: z.enum(['orders_api', 'heuristic', 'manual']),
  pinned: z.boolean(),
  revenueBand: z.string().nullable(),
})

export const familySchema = z.object({
  id: z.string(),
  label: z.string(),
  memberCount: z.number().int(),
  /** main §6.4 — the differentiation axes, rendered as tags. */
  axes: z.array(z.string()),
  groupingSource: z.enum(['taxonomy', 'fact_clustering', 'embedding']),
  lowConfidence: z.boolean(),
})

export const richnessSchema = z.object({
  band: z.enum(['rich', 'okay', 'sparse']),
  productsMissingDetails: z.number().int(),
})

export const profileResponseSchema = z.object({
  description: z.string(),
  language: z.string(),
  country: z.string(),
  audience: z.string(),
  tone: z.string(),
  topProducts: z.array(topProductSchema),
  keywords: z.array(keywordSchema),
  competitors: z.array(competitorSchema),
  competitorSuggestions: z.array(competitorSuggestionSchema),
  families: z.array(familySchema),
  richness: richnessSchema,
  searchConsole: z.object({ connected: z.boolean(), property: z.string().nullable() }),
  confirmed: z.boolean(),
})

export const confirmProfileRequestSchema = z.object({
  description: z.string().min(1),
  language: z.string().min(2),
  country: z.string().length(2),
  audience: z.string(),
  tone: z.string(),
  topProductIds: z.array(z.string()),
})

export const addKeywordRequestSchema = z.object({ term: z.string().min(1) })

export const addCompetitorRequestSchema = z.object({
  domain: z.string().min(1),
  /** ui §3.7 — the blocklist warning's "add anyway". */
  overrideBlocklist: z.boolean().optional(),
})

export const reportGroupingRequestSchema = z.object({
  familyId: z.string(),
  reason: z.string().min(1),
})

// ── Opportunities (main §7, ui §5) ───────────────────────────────────────────

export const opportunitySchema = z.object({
  id: uuidSchema,
  signalType: z.string(),
  entityRef: entityRefSchema,
  recommendedAction: z.enum(OPPORTUNITY_ACTIONS),
  status: z.enum(OPPORTUNITY_STATUSES),
  impact: z.enum(IMPACT_BANDS),
  impactScore: z.number(),
  confidence: z.enum(CONFIDENCE_BANDS),
  confidenceScore: z.number(),
  /** ui §5.2 — the confidence tooltip lists what raised or lowered it. */
  confidenceFactors: z.array(z.object({ label: z.string(), direction: z.enum(['up', 'down']) })),
  evidence: z.array(evidenceFactSchema),
  why: whyLineSchema,
  preconditions: z.array(z.object({ code: z.string(), whatToDo: whyLineSchema })),
  rulesVersion: z.string(),
  limitedIntelligence: z.boolean(),
  detectedAt: isoDateTimeSchema,
  scheduledFor: isoDateSchema.nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
})

export const listOpportunitiesQuerySchema = z.object({
  action: z.array(z.enum(OPPORTUNITY_ACTIONS)).optional(),
  impact: z.array(z.enum(IMPACT_BANDS)).optional(),
  status: z.array(z.enum(OPPORTUNITY_STATUSES)).optional(),
  entityKind: z.array(entityRefSchema.shape.kind).optional(),
  signalType: z.array(z.string()).optional(),
  sort: z.enum(['impact', 'confidence', 'newest']).optional(),
  cursor: z.string().optional(),
})

export const listOpportunitiesResponseSchema = z.object({
  opportunities: z.array(opportunitySchema),
  /** ui §5.1 — the headline count and the per-action chips. No denominators. */
  counts: z.object({
    open: z.number().int(),
    byAction: z.record(z.enum(OPPORTUNITY_ACTIONS), z.number().int()),
  }),
  lastScanAt: isoDateTimeSchema.nullable(),
  nextScanAt: isoDateTimeSchema.nullable(),
  limitedIntelligence: z.boolean(),
  cursor: z.string().nullable(),
})

export const opportunityTaskSchema = z.object({
  id: uuidSchema,
  label: z.string(),
  state: z.enum(['open', 'applied', 'skipped']),
})

/** main §10.3, ui §5.3.4 — current vs suggested, per field, with grounding evidence. */
export const recommendationFieldSchema = z.object({
  field: z.string(),
  current: z.string().nullable(),
  suggested: z.string(),
  evidence: z.string().nullable(),
})

export const opportunityDetailResponseSchema = z.object({
  opportunity: opportunitySchema,
  tasks: z.array(opportunityTaskSchema),
  /** ui §5.3.2 — for query evidence, the SERP snapshot's top results. */
  serpSnapshot: z
    .array(z.object({ position: z.number().int(), domain: z.string(), url: z.string() }))
    .nullable(),
  recommendation: z
    .object({
      state: z.enum(['none', 'generating', 'ready', 'failed_validation']),
      fields: z.array(recommendationFieldSchema),
      internalLinksIn: z.array(z.object({ fromUrl: z.string(), anchor: z.string() })),
      internalLinksOut: z.array(z.object({ toUrl: z.string(), anchor: z.string() })),
      intentNote: z.string().nullable(),
      /** ui §5.3.4 — "no partial output" on failure; the reason renders instead. */
      failureReason: whyLineSchema.nullable(),
    })
    .nullable(),
  history: z.array(
    z.object({
      at: isoDateTimeSchema,
      from: z.enum(OPPORTUNITY_STATUSES).nullable(),
      to: z.enum(OPPORTUNITY_STATUSES),
      actor: z.enum(['user', 'autopilot', 'expiry']),
      reason: whyLineSchema.nullable(),
    }),
  ),
  /** main §9.6.10 — null until the 28-day maturity window closes (invariant 13). */
  outcome: z
    .object({ label: z.string(), measuredAt: isoDateTimeSchema, before: z.number(), after: z.number() })
    .nullable(),
})

export const scheduleOpportunityRequestSchema = z.object({ date: isoDateSchema.optional() })

export const scheduleOpportunityResponseSchema = z.object({
  topicId: uuidSchema,
  scheduledFor: isoDateSchema,
})

export const markTaskAppliedRequestSchema = z.object({ state: z.enum(['applied', 'skipped']) })

// ── Calendar (main §8.7, ui §6.1) ────────────────────────────────────────────

export const topicSchema = z.object({
  id: uuidSchema,
  title: z.string(),
  scheduledFor: isoDateSchema,
  state: z.enum([
    'planned',
    'checking',
    'generating',
    'in_review',
    'published',
    'rejected_by_gate',
    'vetoed',
  ]),
  intentClass: z.enum(INTENT_CLASSES),
  kind: z.enum(['new', 'refresh']),
  source: z.enum(['auto', 'manual', 'exploration']),
  pinned: z.boolean(),
  targetKeyword: z.string().nullable(),
  monthlySearchVolume: z.number().int().nullable(),
  why: whyLineSchema,
  opportunityId: uuidSchema.nullable(),
  signalType: z.string().nullable(),
  /** ui §6.1 — a published day links to the article; a held day carries its reason. */
  articleId: uuidSchema.nullable(),
  rejection: z
    .object({ gate: z.enum(['gate_1', 'gate_2', 'gate_3']), reason: whyLineSchema })
    .nullable(),
})

export const calendarQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
})

export const calendarResponseSchema = z.object({
  topics: z.array(topicSchema),
  /** ui §6.1 — vacation mode / disconnected / kill switch render a paused ribbon. */
  paused: z.object({ active: z.boolean(), reason: z.string().nullable() }),
  nextReplenishmentAt: isoDateSchema.nullable(),
})

export const addTopicRequestSchema = z.object({
  title: z.string().min(1),
  date: isoDateSchema,
  pin: z.boolean().optional(),
})

/**
 * main §8.7 — a manual topic still passes Gate 1, which answers one of four
 * ways: proceed, proceed-with-warning, converted to an OPTIMIZE opportunity
 * (main §7.7 — invariant 6), or rejected with the standard reason.
 */
export const addTopicResponseSchema = z.object({
  outcome: z.enum(['planned', 'planned_with_warning', 'converted', 'rejected']),
  topic: topicSchema.nullable(),
  warning: whyLineSchema.nullable(),
  /** Set when Gate 1's existing-target check converted this to an OPTIMIZE. */
  convertedToOpportunityId: uuidSchema.nullable(),
  rejection: whyLineSchema.nullable(),
})

export const moveTopicRequestSchema = z.object({ date: isoDateSchema })
export const pinTopicRequestSchema = z.object({ pinned: z.boolean() })

// ── Articles (main §9, ui §6.2–6.3) ──────────────────────────────────────────

export const articleSummarySchema = z.object({
  id: uuidSchema,
  title: z.string(),
  state: z.enum(['draft', 'in_review', 'published', 'rejected', 'discarded']),
  delivery: z.enum(['export', 'auto']),
  publishedAt: isoDateTimeSchema.nullable(),
  publishedUrl: z.string().nullable(),
  /** main §8.6, invariant 12 — shown, and segmented, never hidden. */
  publishedViaOverride: z.boolean(),
  repaired: z.boolean(),
  refreshedCount: z.number().int(),
  /** main §9.6 — null until the 28-day window closes (invariant 13). */
  performance: z
    .object({
      clicks28d: z.number().int(),
      position: z.number(),
      trend: z.enum(['up', 'flat', 'down']),
      label: z.enum(['winner', 'neutral', 'underperformer', 'unrated']),
    })
    .nullable(),
})

export const listArticlesQuerySchema = z.object({
  state: z.array(articleSummarySchema.shape.state).optional(),
  hasPerformance: z.boolean().optional(),
  needsAttention: z.boolean().optional(),
  cursor: z.string().optional(),
})

export const listArticlesResponseSchema = z.object({
  articles: z.array(articleSummarySchema),
  cursor: z.string().nullable(),
})

export const articleDetailResponseSchema = z.object({
  article: articleSummarySchema,
  /** ui §6.3 — rendered exactly as it will publish. No editor anywhere. */
  html: z.string(),
  metadata: z.object({
    targetKeyword: z.string(),
    slug: z.string(),
    metaDescription: z.string(),
    familyIds: z.array(z.string()),
    opportunityId: uuidSchema.nullable(),
  }),
  evidencePack: z.array(z.object({ productId: z.string(), title: z.string() })),
  /** ui §6.3 — the collapsed "Quality report": per-criterion scores and justifications. */
  qualityReport: z
    .object({
      scores: z.record(z.string(), z.number()),
      justifications: z.record(z.string(), z.string()),
      promptVersion: z.string(),
      modelId: z.string(),
      passed: z.boolean(),
    })
    .nullable(),
  history: z.array(z.object({ at: isoDateTimeSchema, event: z.string() })),
})

export const confirmPublishedUrlRequestSchema = z.object({
  /** main §9.4 — validated as being on the claimed domain before it feeds attribution. */
  url: z.string().url(),
})

export const overridePublishRequestSchema = z.object({
  /** ui §6.3 — the destructive confirm restates the failing criteria first. */
  acknowledgedCriteria: z.array(z.string()).min(1),
})

// ── Products (ui §7) ─────────────────────────────────────────────────────────

export const merchantTaskSchema = z.object({
  opportunityId: uuidSchema,
  blockingTitle: z.string(),
  impact: z.enum(IMPACT_BANDS),
  products: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      missingFields: z.array(z.string()),
      shopifyAdminUrl: z.string(),
    }),
  ),
  completedAt: isoDateTimeSchema.nullable(),
})

export const productsResponseSchema = z.object({
  richness: richnessSchema,
  counts: z.object({ products: z.number().int(), families: z.number().int() }),
  merchantTasks: z.array(merchantTaskSchema),
  products: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      familyId: z.string().nullable(),
      factCount: z.number().int(),
      richnessBand: z.enum(['rich', 'okay', 'sparse']),
      missingFields: z.array(z.string()),
      lastSyncedAt: isoDateTimeSchema,
    }),
  ),
  cursor: z.string().nullable(),
})

export const familiesResponseSchema = z.object({ families: z.array(familySchema) })

// ── Performance (main §9.6, §12.2, ui §8) ────────────────────────────────────

export const performanceOverviewResponseSchema = z.object({
  connected: z.boolean(),
  /** main §14.4 — gaps render as gaps, never interpolated. */
  series: z.array(
    z.object({ date: isoDateSchema, clicks: z.number().int().nullable(), impressions: z.number().int().nullable() }),
  ),
  markers: z.array(
    z.object({
      date: isoDateSchema,
      kind: z.enum(['gsc_connected', 'article_published', 'optimize_applied']),
      label: z.string(),
    }),
  ),
  results: z.array(
    z.object({
      kind: z.enum(['article', 'page']),
      id: z.string(),
      title: z.string(),
      clicks: z.number().int(),
      impressions: z.number().int(),
      position: z.number(),
      trend: z.enum(['up', 'flat', 'down']),
      label: z.string(),
      publishedViaOverride: z.boolean(),
    }),
  ),
})

export const searchConsoleQuerySchema = z.object({
  dimension: z.enum(['query', 'page']),
  window: z.enum(['28d', '3m', '12m']),
  cursor: z.string().optional(),
})

export const searchConsoleResponseSchema = z.object({
  rows: z.array(
    z.object({
      key: z.string(),
      clicks: z.number().int(),
      impressions: z.number().int(),
      ctr: z.number(),
      position: z.number(),
      deltaClicks: z.number().int(),
      deltaPosition: z.number(),
      pageType: z.enum(['collection', 'product', 'page', 'blog', 'our_article']).nullable(),
      /** ui §8.2 — the table is an entry point into Opportunities, not a reporting island. */
      signals: z.array(z.object({ signalType: z.string(), opportunityId: uuidSchema })),
    }),
  ),
  cursor: z.string().nullable(),
})

// ── Notifications (tech §1, ui §10) ──────────────────────────────────────────

export const notificationSchema = z.object({
  id: uuidSchema,
  type: z.enum(NOTIFICATION_TYPES),
  /** tech §1.2 — references only; display text is produced at render time. */
  refs: z.record(z.string(), z.string()),
  createdAt: isoDateTimeSchema,
  seenAt: isoDateTimeSchema.nullable(),
  readAt: isoDateTimeSchema.nullable(),
})

export const notificationsQuerySchema = z.object({ since: isoDateTimeSchema.optional() })

export const notificationsResponseSchema = z.object({
  notifications: z.array(notificationSchema),
  unseenCount: z.number().int(),
})

/** tech §1.1 — attention items are a live query, never stored notifications. */
export const attentionResponseSchema = z.object({
  items: z.array(
    z.object({
      kind: z.enum([
        'draft_awaiting_review',
        'repair_pending',
        'export_url_unconfirmed',
        'merchant_task',
        'optimize_unapplied',
      ]),
      refs: z.record(z.string(), z.string()),
      since: isoDateTimeSchema,
    }),
  ),
})

// ── Webhooks (tech §3) ───────────────────────────────────────────────────────

/**
 * Webhook receivers verify a signature before touching the body and return 200
 * regardless of processing outcome (main §14.3.8, tech §3). The body is opaque
 * to us at the boundary — it is stored and processed from the table — so the
 * schema is deliberately unconstrained.
 */
export const webhookAckSchema = z.object({ received: z.literal(true) })
