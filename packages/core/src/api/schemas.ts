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
 * The request and response shapes for every `/api/*` route.
 * These are the single source of truth: the OpenAPI document is generated from
 * them, the MSW handlers validate against them, and route handlers parse with
 * them (CLAUDE.md: "parse → call core → serialise").
 *
 * Two product rules are enforced in the schema itself rather than left to each
 * screen:
 *
 * - **No denominators**: count fields are bare
 *   numbers. There is no `of` or `target` field anywhere for a UI to render
 *   "3 of 30" from, because the cap is a ceiling and not a promise.
 * - **Every why-line is a template key plus params**:
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

/** A reason the merchant reads, carried as a key and its parameters so the wording is ours and an LLM never writes it. */
export const whyLineSchema = z.object({
  templateKey: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
})

export const evidenceFactSchema = z.object({
  key: z.string(),
  value: z.union([z.string(), z.number()]),
  /** Where the fact came from and over what period, so the card can show the merchant why we believe it. */
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

// ── Preview ──────────────────────────────────────────────────────────────────

export const previewRequestSchema = z.object({
  url: z.string().min(1),
  /** Verified server-side before any fetch happens; a client-side check would be no check at all. */
  turnstileToken: z.string().min(1),
})

export const previewResponseSchema = z.object({
  domain: z.string(),
  /** The Haiku 2–3 sentence summary, or null on the graceful generic card. */
  summary: z.string().nullable(),
  /** A cache hit skips the scrape and the LLM entirely, so it costs nothing. */
  cacheHit: z.boolean(),
  /**
   * True when the scrape failed or the preview spend cap has tripped: the UI
   * renders the generic card, never an error state, because a stranger who
   * typed their domain in should not meet our plumbing.
   */
  generic: z.boolean(),
})

// ── Account, billing, settings ───────────────────────────────────────────────

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
  /** Read from our own row, never by calling Stripe: no request path may depend on their availability. */
  subscription: z.object({
    // `incomplete` — the first payment is still being authorised — is a fifth
    // status added by card T1.2a; see `packages/db/src/schema/enums.ts`. Like
    // `incomplete_expired` it is not entitled, so no consumer's gating changes.
    status: z.enum(['active', 'comped', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'none']),
    cancelAtPeriodEnd: z.boolean(),
    currentPeriodEnd: isoDateTimeSchema.nullable(),
  }),
  /** No Search Console connected, so everything here is inferred rather than measured. */
  limitedIntelligence: z.boolean(),
  connections: z.object({
    shopify: z.enum(['none', 'read', 'read_write', 'broken']),
    searchConsole: z.enum(['none', 'connected', 'broken']),
    lastScanAt: isoDateTimeSchema.nullable(),
  }),
  /** A kill switch is active; the UI renders the outage copy rather than pretending work is queued. */
  servicePaused: z.boolean(),
})

export const checkoutRequestSchema = z.object({ interval: z.enum(['monthly', 'annual']) })
export const redirectResponseSchema = z.object({ url: z.string().url() })

/**
 * The plan card: the price, the monthly/annual toggle, the verbatim cap line
 * and the inclusions.
 *
 * Amounts come from Stripe on every response — the app never hardcodes a dollar
 * amount anywhere — in minor units with their currency, so the client formats
 * and the API bakes in no locale. The
 * −20% annual saving is not a field: it is whatever the two amounts say it is,
 * which is the point of reading them from Stripe.
 */
export const planResponseSchema = z.object({
  planKey: z.literal('pro'),
  name: z.string(),
  /** Fixed copy, used word for word, and never rendered with a denominator behind it. */
  capLine: z.string(),
  inclusions: z.array(z.string()),
  cancelAnytime: z.string(),
  /** The three cancellation facts, stated wherever cancellation is offered rather than only in the terms. */
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
  /** Export is the default; publishing on the merchant's behalf is a separate, later consent. */
  delivery: z.enum(['export', 'auto']),
  shopifyPublishAs: z.enum(['live', 'draft']),
  publishHour: z.number().int().min(0).max(23),
  timezone: z.string(),
  draftReview: z.boolean(),
  autoRepair: z.boolean(),
  vacationMode: z.boolean(),
  uiLanguage: z.string().nullable(),
  /** Only the opt-in notifications are toggleable; the transactional ones are not. */
  emailArticlePublished: z.boolean(),
  emailDigestFrequency: z.enum(['off', 'daily', 'weekly']),
})

export const settingsPatchSchema = settingsSchema.partial()

export const blogsResponseSchema = z.object({
  blogs: z.array(z.object({ id: z.string(), title: z.string(), handle: z.string() })),
})

export const selectBlogRequestSchema = z.object({
  blogId: z.string().optional(),
  /** Offered when the store has no blog yet, so choosing a target is one click rather than a trip to Shopify. */
  createNamed: z.string().optional(),
})

export const deleteAccountRequestSchema = z.object({
  /** The user must type this back; the action is not reversible. */
  confirmation: z.literal('DELETE'),
})

// ── Domain claim ─────────────────────────────────────────────────────────────

export const claimDomainRequestSchema = z.object({ domain: z.string().min(1) })

export const claimDomainResponseSchema = z.object({
  normalized: z.string(),
  state: domainStateSchema,
  /** The claim enqueues the ingestion run, so the client has a job to follow straight away. */
  ingestionJobId: uuidSchema,
})

// ── Ingestion progress ───────────────────────────────────────────────────────

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
  /** Drives the elapsed-time readout the UI shows once a step has been running a while. */
  startedAt: isoDateTimeSchema,
})

// ── Search Console ───────────────────────────────────────────────────────────

export const gscPropertiesResponseSchema = z.object({
  properties: z.array(
    z.object({
      siteUrl: z.string(),
      permissionLevel: z.string(),
      /** Set when the property does not match the claimed domain, so the UI can say so inline rather than after submit. */
      matchesClaimedDomain: z.boolean(),
    }),
  ),
})

export const selectGscPropertyRequestSchema = z.object({ siteUrl: z.string().min(1) })

// ── Store profile / confirmation ─────────────────────────────────────────────

export const keywordSchema = z.object({
  id: uuidSchema,
  term: z.string(),
  /** Null while enrichment is still running, which the UI renders as a skeleton rather than as zero. */
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

/** A domain we saw ranking. It may be suggested to the merchant, never added to their competitor list on its own. */
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
  /** What makes this family's products differ from each other, rendered as tags. */
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
  /** Lets the merchant proceed past the blocklist warning deliberately. */
  overrideBlocklist: z.boolean().optional(),
})

export const reportGroupingRequestSchema = z.object({
  familyId: z.string(),
  reason: z.string().min(1),
})

// ── Opportunities ────────────────────────────────────────────────────────────

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
  /** The individual reasons the confidence score moved up or down, so the tooltip can show its working. */
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
  /** The headline count and the per-action chips. Bare numbers: no denominators anywhere. */
  counts: z.object({
    open: z.number().int(),
    byAction: z.record(z.enum(OPPORTUNITY_ACTIONS), z.number().int()),
  }),
  lastScanAt: isoDateTimeSchema.nullable(),
  nextScanAt: isoDateTimeSchema.nullable(),
  /**
   * The store's own timezone, so the two instants above can be named as days.
   *
   * An instant alone is not enough to print a date. A Berlin store's next scan
   * is `2026-09-13T22:00Z`, which is their Monday the 14th and reads as Sunday
   * the 13th to anything that formats it in UTC — a day early, always, for
   * every store east of us. Always present: a store that has never chosen one
   * has `UTC`, which is a real answer rather than a missing one.
   */
  timezone: z.string(),
  limitedIntelligence: z.boolean(),
  cursor: z.string().nullable(),
})

export const opportunityTaskSchema = z.object({
  id: uuidSchema,
  label: z.string(),
  state: z.enum(['open', 'applied', 'skipped']),
})

/** Current versus suggested, field by field, each with the evidence behind the suggestion. */
export const recommendationFieldSchema = z.object({
  field: z.string(),
  current: z.string().nullable(),
  suggested: z.string(),
  evidence: z.string().nullable(),
})

export const opportunityDetailResponseSchema = z.object({
  opportunity: opportunitySchema,
  tasks: z.array(opportunityTaskSchema),
  /** For query evidence, the top results from the SERP snapshot we scored against. */
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
      /** On failure there is no partial output at all; this reason renders in its place. */
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
  /** Null until 28 days have passed; before that there is nothing honest to say about whether it worked. */
  outcome: z
    .object({ label: z.string(), measuredAt: isoDateTimeSchema, before: z.number(), after: z.number() })
    .nullable(),
})

export const scheduleOpportunityRequestSchema = z.object({ date: isoDateSchema.optional() })

export const scheduleOpportunityResponseSchema = z.object({
  topicId: uuidSchema,
  scheduledFor: isoDateSchema,
})

// ── Calendar ─────────────────────────────────────────────────────────────────

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
  /** A published day links to the article; a held day carries the reason it was held. */
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
  /** Why nothing is being produced — vacation mode, a broken connection, a kill switch — behind the paused ribbon. */
  paused: z.object({ active: z.boolean(), reason: z.string().nullable() }),
  nextReplenishmentAt: isoDateSchema.nullable(),
})

export const addTopicRequestSchema = z.object({
  title: z.string().min(1),
  date: isoDateSchema,
  pin: z.boolean().optional(),
})

/**
 * A topic the merchant added by hand still goes through the same admission
 * gate as one we picked, which answers one of four ways: proceed, proceed with
 * a warning, converted into an OPTIMIZE because we already have a page ranking
 * for it, or rejected with the standard reason.
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

// ── Articles ─────────────────────────────────────────────────────────────────

export const articleSummarySchema = z.object({
  id: uuidSchema,
  title: z.string(),
  state: z.enum(['draft', 'in_review', 'published', 'rejected', 'discarded']),
  delivery: z.enum(['export', 'auto']),
  publishedAt: isoDateTimeSchema.nullable(),
  publishedUrl: z.string().nullable(),
  /** Published past a failed quality gate on the merchant's instruction. Always shown, always segmented away from the rest, never quietly hidden. */
  publishedViaOverride: z.boolean(),
  repaired: z.boolean(),
  refreshedCount: z.number().int(),
  /** Null until 28 days have passed, because anything earlier is noise. */
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
  /** Rendered exactly as it will publish. There is no editor anywhere in the product. */
  html: z.string(),
  metadata: z.object({
    targetKeyword: z.string(),
    slug: z.string(),
    metaDescription: z.string(),
    familyIds: z.array(z.string()),
    opportunityId: uuidSchema.nullable(),
  }),
  evidencePack: z.array(z.object({ productId: z.string(), title: z.string() })),
  /** The quality report behind the draft: a score and a justification per criterion. */
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
  /** Validated as being on the claimed domain before it feeds attribution, so a wrong URL cannot borrow another store's numbers. */
  url: z.string().url(),
})

export const overridePublishRequestSchema = z.object({
  /** The confirm dialog restates the criteria the draft failed before it lets the merchant publish anyway. */
  acknowledgedCriteria: z.array(z.string()).min(1),
})

// ── Products ─────────────────────────────────────────────────────────────────

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

// ── Performance ──────────────────────────────────────────────────────────────

export const performanceOverviewResponseSchema = z.object({
  connected: z.boolean(),
  /** Days we have no data for stay null: a gap renders as a gap, never as an interpolated line. */
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
      /** Links each row back into Opportunities, so the table is a way in to doing something rather than a report to admire. */
      signals: z.array(z.object({ signalType: z.string(), opportunityId: uuidSchema })),
    }),
  ),
  cursor: z.string().nullable(),
})

// ── Notifications ────────────────────────────────────────────────────────────

export const notificationSchema = z.object({
  id: uuidSchema,
  type: z.enum(NOTIFICATION_TYPES),
  /** References only. The display text is produced at render time, so stored notifications never go stale against changed copy. */
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

/** Attention items are computed live from current state; they are never stored rows, so they cannot linger after the thing they were about is resolved. */
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
      /**
       * What each item points at, named rather than left open.
       *
       * This was `Record<string, string>`, and an open map is a hole: every
       * key survives it, misspellings included. The dashboard read `articleId`
       * and `opportunityId`; the server has always sent `article_id` and
       * `opportunity_id`, so four of the five kinds linked a merchant to a
       * general page instead of the thing wanting their attention — on the
       * first screen they see. Both spellings were legal here, so nothing
       * could catch it, and the mock the frontend develops against used the
       * screen's spelling, which made the links work in development and only
       * there.
       *
       * Named in the underscore form because that is the vocabulary the
       * notification record already uses, in rows already written and in a
       * rule of its own that says to name the thing rather than the words.
       * Every field is optional because which ones an item carries depends on
       * its kind — but a name that is not one of these no longer passes.
       */
      refs: z
        .object({
          article_id: uuidSchema.optional(),
          opportunity_id: uuidSchema.optional(),
          task_id: uuidSchema.optional(),
          recommendation_id: uuidSchema.optional(),
        })
        .strict(),
      since: isoDateTimeSchema,
    }),
  ),
})

// ── Publishing target and delivery mode ──────────────────────────────────────

/**
 * These live under `/api/publish/*` rather than `/api/settings/*`, which is
 * where an earlier version of this table put them. The addresses that were
 * built are grouped by what they do; the table now follows them.
 */
export const selectBlogResponseSchema = z.object({
  ok: z.literal(true),
  blog: z.object({ id: z.string(), title: z.string(), handle: z.string() }),
})

export const setDeliveryModeRequestSchema = z.object({
  /** Auto-publish on (`auto`) or off (`export`). */
  delivery: z.enum(['auto', 'export']).optional(),
  /** Whether an auto-published post goes live or waits as a Shopify draft. */
  shopifyPublishAs: z.enum(['live', 'draft']).optional(),
})

export const setDeliveryModeResponseSchema = z.object({
  ok: z.literal(true),
  /** Absent when the call only changed the live-or-draft choice. */
  delivery: z.enum(['auto', 'export']).optional(),
})

// ── Opportunity scan progress ────────────────────────────────────────────────

/**
 * What the "finding your growth opportunities" screen polls, and the payload of
 * the stream beside it.
 *
 * There is deliberately no per-stage text. A timer ticking through invented
 * stage names would be untrue on the one screen whose job is to earn trust
 * before the product has produced anything, so this reports only what is real:
 * whether the run is going, when it started, and its actual counts.
 */
export const scanStatusResponseSchema = z.union([
  z.object({ status: z.literal('not_started') }),
  z.object({
    runId: uuidSchema,
    kind: z.string(),
    status: z.enum(['running', 'finished']),
    startedAt: isoDateTimeSchema,
    finishedAt: isoDateTimeSchema.nullable(),
    opportunitiesCreated: z.number().int(),
    opportunitiesUpdated: z.number().int(),
    opportunitiesExpired: z.number().int(),
  }),
])

// ── Recommendations ──────────────────────────────────────────────────────────

export const generateRecommendationRequestSchema = z.object({
  opportunityId: uuidSchema,
})

/**
 * `generated` says whether this call started the work or found it already
 * running or done — the same request twice costs one generation, not two.
 */
export const generateRecommendationResponseSchema = z.object({
  state: z.enum(['generating', 'ready']),
  opportunityId: uuidSchema.optional(),
  recommendationId: uuidSchema.optional(),
  generated: z.boolean(),
})

export const readRecommendationQuerySchema = z.object({
  opportunityId: uuidSchema,
})

/**
 * The same task, with the field the recommendations endpoint sends and the
 * opportunity drawer does not: which kind of edit it is. Declared here rather
 * than added to `opportunityTaskSchema` because the drawer genuinely does not
 * send it, and widening the shared schema would declare a field one of its two
 * endpoints omits — the fault this correction exists to remove.
 */
export const recommendationTaskSchema = opportunityTaskSchema.extend({
  kind: z.enum([
    'title_rewrite',
    'meta_rewrite',
    'add_section',
    'add_faq',
    'internal_links',
    'product_data',
    'consolidate',
    'primary_url',
    'canonical_recommendation',
    'schedule_topic',
    'repair_reference',
  ]),
})

const fixSectionLineSchema = z.object({
  templateKey: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
})

/**
 * A FIX recommendation as the drawer shows it: three sections in the order the
 * merchant has to act in, and the line saying we changed nothing in their shop.
 * Every piece of prose is a key plus its numbers, never a finished sentence.
 */
export const fixRecommendationViewSchema = z.object({
  kind: z.literal('cannibalization_consolidation'),
  clusterHead: z.string(),
  sections: z.array(
    z.object({
      kind: z.enum(['primary_url', 'internal_links', 'canonical']),
      headingKey: z.string(),
      lines: z.array(fixSectionLineSchema),
    }),
  ),
  trustLineKey: z.string(),
})

/**
 * The full recommendation — what the drawer shows and what the download is
 * built from, which are the same thing since they were made one view.
 */
export const optimizeRecommendationViewSchema = z.object({
  id: uuidSchema,
  state: z.enum(['ready', 'failed_validation']),
  pageUrl: z.string(),
  fields: z.array(recommendationFieldSchema),
  sections: z.array(
    z.object({ heading: z.string(), copy: z.string(), evidence: z.array(z.string()) }),
  ),
  faq: z.array(z.object({ q: z.string(), a: z.string(), evidence: z.array(z.string()) })),
  internalLinksIn: z.array(z.object({ fromUrl: z.string(), anchor: z.string() })),
  internalLinksOut: z.array(z.object({ toUrl: z.string(), anchor: z.string() })),
  intentNote: z.string().nullable(),
  failureReason: whyLineSchema.nullable(),
  generatedAt: isoDateTimeSchema,
})

/**
 * What reading a recommendation actually answers — four shapes, not one.
 *
 * This schema is deliberately a union rather than one object with everything
 * made optional, because the four cases are genuinely different answers and a
 * client that cannot tell them apart will render the wrong thing. They are:
 * advice that exists; advice being written right now; a technical fix, which is
 * a different shape entirely and carries no recommendation; and nothing at all.
 *
 * It replaces a declaration that named the opportunity-drawer shape, which this
 * endpoint has never returned. Nothing was red, because the contract check
 * compares the declarations to each other and to the routes that exist — never
 * to what a handler answers. See `R-CONTRACT-2`.
 */
export const readRecommendationResponseSchema = z.union([
  z.object({
    recommendation: optimizeRecommendationViewSchema,
    tasks: z.array(recommendationTaskSchema),
    /** The page already looks edited, so we offer to record it rather than assert it. */
    looksApplied: z
      .object({ signals: z.array(z.string()), headings: z.array(z.string()) })
      .nullable(),
    appliedAt: isoDateTimeSchema.nullable(),
  }),
  z.object({
    recommendation: z.object({ state: z.literal('generating'), opportunityId: uuidSchema }),
    tasks: z.array(recommendationTaskSchema),
    looksApplied: z.null(),
  }),
  z.object({
    recommendation: z.null(),
    fix: fixRecommendationViewSchema.nullable(),
    tasks: z.array(recommendationTaskSchema),
    looksApplied: z.null(),
  }),
  z.object({
    recommendation: z.null(),
    tasks: z.array(recommendationTaskSchema),
    looksApplied: z.null(),
  }),
])

export const applyRecommendationRequestSchema = z.object({
  /** Absent means the whole recommendation rather than one task. */
  taskId: uuidSchema.optional(),
})

/**
 * Skipping is per task and the task must be named — deliberately unlike
 * applying, where an absent id means the whole recommendation.
 *
 * There is no "skip the whole recommendation": a merchant who wants nothing to
 * do with a suggestion dismisses the opportunity, which is a different act with
 * a different record. Letting an empty body mean "skip everything" would make
 * the commonest accident — a request that lost its body — the most destructive
 * one.
 */
export const skipTaskRequestSchema = z.object({
  taskId: uuidSchema,
})

/**
 * Skipping records what the merchant actually said. It is a separate address
 * and a separate answer from applying because the two are different merchant
 * answers, and recording a declined task as a done one would put a false row
 * in the table that outcome measurement reads.
 */
export const skipTaskResponseSchema = z.object({
  ok: z.literal(true),
  taskId: uuidSchema,
  state: z.literal('skipped'),
})

/**
 * Marking the whole thing applied is what starts the clock: the opportunity
 * completes and the measurement of whether it worked is booked for the first
 * date on which there is anything honest to say.
 */
export const applyRecommendationResponseSchema = z.object({
  ok: z.literal(true),
  taskId: uuidSchema.optional(),
  state: z.string().optional(),
  appliedAt: isoDateTimeSchema.optional(),
  outcomeDueAt: isoDateTimeSchema.optional(),
})

// ── Article export ───────────────────────────────────────────────────────────

/**
 * Three files in one answer rather than one file per request: the merchant
 * presses one of three buttons and expects a file each time, and the values in
 * all three are read from the store in a single pass — three separate requests
 * could straddle a price change and disagree with each other.
 */
export const articleExportResponseSchema = z.object({
  /**
   * A list rather than a name-to-contents map, which is what this endpoint has
   * always answered — each file carries its own name and type because the
   * merchant saves it under that name and the browser needs the type to hand it
   * over. The map was declared here and never served; `R-CONTRACT-PROVE` found
   * it by parsing the real answer, which is the check the declaration had
   * never faced.
   */
  files: z.array(
    z.object({
      filename: z.string(),
      mimeType: z.string(),
      content: z.string(),
    }),
  ),
})

// ── Webhooks ─────────────────────────────────────────────────────────────────

/**
 * Webhook receivers verify a signature before touching the body and return 200
 * regardless of processing outcome. The body is opaque
 * to us at the boundary — it is stored and processed from the table — so the
 * schema is deliberately unconstrained.
 */
export const webhookAckSchema = z.object({ received: z.literal(true) })
