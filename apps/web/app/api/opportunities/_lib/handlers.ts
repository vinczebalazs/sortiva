import {
  OPPORTUNITY_ACTIONS,
  listOpportunitiesQuerySchema,
  listOpportunitiesResponseSchema,
  opportunitySchema,
  scheduleOpportunityRequestSchema,
  scheduleOpportunityResponseSchema,
  toContractOpportunity,
  type ConflictCode,
  type Opportunity,
} from '@sortiva/core'
import {
  findOpportunityById,
  listOpenOpportunities,
  listSignalRuns,
  undismissOpportunity,
  type Db,
  type OpportunityRow,
} from '@sortiva/db'
// Deep import, not the `@sortiva/jobs` barrel — the same build-time
// `DATABASE_URL is not set` failure `apps/web/app/api/calendar/_lib/handlers.ts`
// hit already (its own note explains why); `TopicScheduler` and
// `TopicSchedulingError` live behind the same barrel chain.
import { DbTopicScheduler, TopicSchedulingError } from '@sortiva/jobs/generation/topic-scheduler'
import { dismissOpportunity } from '@sortiva/jobs/generation/veto-topic'
import { rules } from '@sortiva/rules'
import type { AccountHandler } from '../../auth/_lib/session'

/**
 * `/api/opportunities` — the Growth Opportunities surface's own read and its
 * three merchant actions (ui spec §5). Detail-drawer fields this card's own
 * data cannot back honestly — `recommendation` (`T6.2`), `history` (no audit
 * log exists), `outcome` (`T7.1`, deferred with the rest of `M7`) — are not
 * built here; `GET /api/opportunities/{id}` is intentionally not implemented
 * by this card. See DECISIONS 2026-09-03 T3.7.
 */

export interface OpportunitiesDeps {
  readonly db: Db
}

export type OpportunityRouteCtx = { readonly params: Promise<{ id: string }> }

const CONFLICT_MESSAGES: Partial<Record<ConflictCode, string>> = {
  opportunity_already_updated: 'This opportunity was updated by the latest scan — refreshed.',
  opportunity_not_open: 'This opportunity is no longer open.',
}

function conflict(code: ConflictCode): Response {
  return Response.json(
    { error: { code, message: CONFLICT_MESSAGES[code] ?? 'That change could not be made.' } },
    { status: 409 },
  )
}

function notFound(): Response {
  return Response.json(
    { error: { code: 'opportunity_not_found', message: 'That opportunity is gone.' } },
    { status: 404 },
  )
}

/**
 * The tooltip's own working (ui §5.2: "GSC data ✓ · 28-day window ✓ ·
 * limited intelligence −"), read back off what the row itself stored —
 * `evidence_json`, `preconditions_json`, `limited_intelligence` all persist;
 * two of `confidenceScore`'s seven additive points do not (`substanceFloorMargin`,
 * `validatedAcrossConsecutiveScans` are scan-time-only booleans with no
 * column or evidence fact to read back), so this is a best-effort
 * reconstruction, not a stored record of the exact points that were
 * actually added. `opportunitySchema.confidenceFactors[].label` is a plain
 * string in the frozen contract (not a template key + params like `why`),
 * so the short labels are written here rather than in `packages/core` —
 * consistent with the contract as written, not a new copy-placement choice.
 */
function confidenceFactorsOf(row: OpportunityRow): { label: string; direction: 'up' | 'down' }[] {
  const scoring = rules().defaults.scoring.confidence
  const evidence = (row.evidenceJson ?? []) as readonly { source: string; window?: string }[]
  const windowDays = evidence.reduce((max, fact) => {
    const match = /^(\d+)d/.exec(fact.window ?? '')
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  const out: { label: string; direction: 'up' | 'down' }[] = []
  if (evidence.some((f) => f.source === 'gsc')) out.push({ label: 'GSC data', direction: 'up' })
  if (windowDays >= scoring.evidence_window_days_tier_1) out.push({ label: '28-day window', direction: 'up' })
  if (windowDays >= scoring.evidence_window_days_tier_2) out.push({ label: '84-day window', direction: 'up' })
  if (new Set(evidence.map((f) => f.source)).size >= scoring.independent_sources_min) {
    out.push({ label: 'Independent sources agree', direction: 'up' })
  }
  const preconditions = (row.preconditionsJson ?? []) as readonly string[]
  if (preconditions.length === 0) out.push({ label: 'No open blocker', direction: 'up' })
  if (row.limitedIntelligence) out.push({ label: 'Limited Intelligence', direction: 'down' })
  return out
}

function serialise(row: OpportunityRow, opportunity: Opportunity) {
  return opportunitySchema.parse({
    id: opportunity.id,
    signalType: opportunity.signalType,
    entityRef: opportunity.entityRef,
    recommendedAction: opportunity.recommendedAction,
    status: opportunity.status,
    impact: opportunity.impact,
    impactScore: opportunity.impactScore,
    confidence: opportunity.confidence,
    confidenceScore: opportunity.confidenceScore,
    confidenceFactors: confidenceFactorsOf(row),
    evidence: opportunity.evidence,
    why: { templateKey: opportunity.reasonTemplateKey, params: opportunity.reasonParams },
    // No per-precondition "what to do" copy exists yet (that is Lane F's
    // string catalogue); the same key convention the why-line renderer
    // already falls back gracefully on, per DECISIONS 2026-09-03 T3.6.
    preconditions: opportunity.preconditions.map((code) => ({
      code,
      whatToDo: { templateKey: `precondition.${code}`, params: {} },
    })),
    rulesVersion: opportunity.rulesVersion,
    limitedIntelligence: opportunity.limitedIntelligence,
    detectedAt: opportunity.detectedAt,
    // No topic lookup here — a real but secondary field the calendar screen
    // itself already answers; left null with a documented reason rather
    // than built speculatively (CLAUDE.md §4), matching `T4.2`'s own
    // precedent for `topics.monthlySearchVolume`.
    scheduledFor: null,
    expiresAt: null,
  })
}

/** Array-valued filters arrive as repeated keys (`?action=CREATE&action=OPTIMIZE`); everything else is scalar. */
const ARRAY_QUERY_KEYS = ['action', 'impact', 'status', 'entityKind', 'signalType'] as const

function parseListQuery(url: string): Record<string, string | string[]> {
  const params = new URL(url).searchParams
  const out: Record<string, string | string[]> = {}
  for (const key of new Set(params.keys())) {
    out[key] = (ARRAY_QUERY_KEYS as readonly string[]).includes(key) ? params.getAll(key) : (params.get(key) ?? '')
  }
  return out
}

export function makeListOpportunitiesHandler(deps: OpportunitiesDeps): AccountHandler {
  return async (request, { scope }) => {
    const parsed = listOpportunitiesQuerySchema.safeParse(parseListQuery(request.url))
    if (!parsed.success) {
      return Response.json({ error: { code: 'invalid_query', message: 'Could not parse the filters.' } }, { status: 422 })
    }
    const q = parsed.data
    const confidenceConfig = rules().defaults.scoring.confidence

    const rows = await listOpenOpportunities(deps.db, scope)
    const opportunities = rows.map((row) => ({ row, opportunity: toContractOpportunity(row, confidenceConfig) }))

    const filtered = opportunities.filter(({ opportunity }) => {
      if (q.action && !q.action.includes(opportunity.recommendedAction)) return false
      if (q.impact && !q.impact.includes(opportunity.impact)) return false
      if (q.status && !q.status.includes(opportunity.status)) return false
      if (q.entityKind && !q.entityKind.includes(opportunity.entityRef.kind)) return false
      if (q.signalType && !q.signalType.includes(opportunity.signalType)) return false
      return true
    })

    const sorted = [...filtered].sort((a, b) => {
      if (q.sort === 'confidence') return b.opportunity.confidenceScore - a.opportunity.confidenceScore
      if (q.sort === 'newest') return b.opportunity.detectedAt.localeCompare(a.opportunity.detectedAt)
      return b.opportunity.impactScore - a.opportunity.impactScore
    })

    // `opportunitySchema.counts.byAction` is a `z.record` over the closed
    // action enum, which Zod validates as exhaustive — every key must be
    // present, not just the ones this store happens to have open right now.
    // A store with (say) no open FIX opportunities is the common case, not
    // an edge case, so this starts at zero for all five rather than only
    // the actions actually seen.
    const byAction = Object.fromEntries(OPPORTUNITY_ACTIONS.map((action) => [action, 0])) as Record<
      (typeof OPPORTUNITY_ACTIONS)[number],
      number
    >
    for (const { opportunity } of opportunities) {
      byAction[opportunity.recommendedAction] += 1
    }

    const runs = await listSignalRuns(deps.db, scope)
    const lastFinished = runs.find((r) => r.finishedAt)

    const body = {
      opportunities: sorted.map(({ row, opportunity }) => serialise(row, opportunity)),
      counts: { open: opportunities.length, byAction },
      lastScanAt: lastFinished?.finishedAt ? lastFinished.finishedAt.toISOString() : null,
      // Nothing schedules a next-scan prediction anywhere in this codebase;
      // null is the honest answer rather than a guessed cadence string.
      nextScanAt: null,
      limitedIntelligence: opportunities.some(({ opportunity }) => opportunity.limitedIntelligence),
      // No cursor pagination in this card's own implementation — a store's
      // open-opportunity count is small enough that one page covers it
      // today; a real cursor is a follow-up, not built speculatively.
      cursor: null,
    }

    return Response.json(listOpportunitiesResponseSchema.parse(body))
  }
}

/**
 * "Not interested" — and the article it had already booked never appears.
 *
 * The suggestion and the calendar day it produced are called off together, by
 * the calendar's own operation rather than by this route reaching into the
 * calendar's rows. Dismissing used to touch only the suggestion, so the daily
 * writing cycle — which works off the calendar day and never looks at the
 * suggestion — went on and published anyway.
 *
 * A publication landing at the same moment wins: the whole cancellation is
 * rolled back and this answers with a conflict, rather than telling the
 * merchant it dropped something that is already on their site. The frozen
 * contract gives this route two conflict codes and neither names a
 * publication, so that lost race is reported as the closest of them — the
 * suggestion is no longer something we can act on.
 */
export function makeDismissOpportunityHandler(deps: OpportunitiesDeps): AccountHandler<OpportunityRouteCtx> {
  return async (_request, { scope, route }) => {
    const { id } = await route.params
    const result = await dismissOpportunity({ db: deps.db }, { accountId: scope.accountId, opportunityId: id })
    if (!result.ok) {
      const existing = await findOpportunityById(deps.db, scope, id)
      return existing ? conflict('opportunity_not_open') : notFound()
    }
    return Response.json({ ok: true, status: result.status })
  }
}

export function makeUndismissOpportunityHandler(deps: OpportunitiesDeps): AccountHandler<OpportunityRouteCtx> {
  return async (_request, { scope, route }) => {
    const { id } = await route.params
    const row = await undismissOpportunity(deps.db, scope, id)
    if (!row) {
      const existing = await findOpportunityById(deps.db, scope, id)
      return existing ? conflict('opportunity_not_open') : notFound()
    }
    return Response.json({ ok: true, status: row.status })
  }
}

/**
 * `POST /api/opportunities/{id}/schedule` — ui §5.4: under the V1 autopilot
 * policy CREATE/REFRESH auto-schedule at replenishment already; this exists
 * to pull one forward, or to place one Gate 1 has not yet run for (manual
 * pull, not autopilot — the caller is a merchant clicking a button, so
 * running the real `TopicScheduler` here, unlike the autopilot path, is
 * correct: the opportunity was already `accepted` by definition of
 * appearing on this screen with a Schedule button, main §7.9's own policy).
 */
export function makeScheduleOpportunityHandler(deps: OpportunitiesDeps): AccountHandler<OpportunityRouteCtx> {
  return async (request, { scope, route }) => {
    const { id } = await route.params
    let body: unknown = {}
    try {
      body = await request.json()
    } catch {
      // No body is a valid request — "pick the next open day" is the default.
    }
    const parsed = scheduleOpportunityRequestSchema.safeParse(body)
    if (!parsed.success) {
      return Response.json({ error: { code: 'invalid_body', message: 'Provide date as YYYY-MM-DD, or nothing.' } }, { status: 422 })
    }

    const row = await findOpportunityById(deps.db, scope, id)
    if (!row) return notFound()
    if (row.status !== 'accepted' || (row.recommendedAction !== 'create' && row.recommendedAction !== 'refresh')) {
      return conflict('opportunity_not_open')
    }

    const confidenceConfig = rules().defaults.scoring.confidence
    const opportunity = toContractOpportunity(row, confidenceConfig)
    const scheduler = new DbTopicScheduler({ db: deps.db })

    try {
      const topic = await scheduler.schedule(opportunity, parsed.data.date)
      // Completes main §7.9's `accepted → scheduled` edge — the same
      // guarded transition `runOnboardingScan` makes after its own call to
      // `.schedule()` (DECISIONS 2026-09-03 T3.7): nothing inside
      // `TopicScheduler` itself moves the opportunity's own status.
      const { transitionOpportunityStatus } = await import('@sortiva/db')
      await transitionOpportunityStatus(deps.db, scope, id, { from: ['accepted'], to: 'scheduled' })
      return Response.json(scheduleOpportunityResponseSchema.parse({ topicId: topic.topicId, scheduledFor: topic.scheduledFor }))
    } catch (error) {
      if (error instanceof TopicSchedulingError) {
        return Response.json(
          { error: { code: 'opportunity_not_schedulable', message: 'This opportunity cannot be scheduled yet — try again after the next scan.' } },
          { status: 422 },
        )
      }
      throw error
    }
  }
}
