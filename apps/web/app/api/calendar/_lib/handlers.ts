import { calendarQuerySchema, calendarResponseSchema, type LifecycleGate } from '@sortiva/core'
// Deep import, not the `@sortiva/jobs` barrel: the barrel's `./runtime`
// export drags in `worker.ts` and, through it, `graphile-worker` — the same
// bundle-breaking chain `apps/web/app/api/shopify/_lib/config.ts` and
// `apps/web/app/api/calendar/topics/_lib/config.ts` already avoid by deep
// importing. This route hit it for real: `pnpm build` failed collecting page
// data for the calendar routes with "DATABASE_URL is not set", raised deep
// inside `graphile-worker`'s own config loader, not this file.
import { accountLifecycleGate, mayAccountWorkRun, type WorkGateDecision } from '@sortiva/jobs/runtime/gate'
import {
  findArticlesByTopics,
  findOpportunitiesByIds,
  latestGateDecisionsForTopics,
  listTopicsInRange,
  reasonParamsOf,
  type ArticleRow,
  type Db,
  type GateDecisionRow,
  type OpportunityRow,
  type TopicRow,
} from '@sortiva/db'
import type { AccountHandler } from '../../auth/_lib/session'

/**
 * `GET /api/calendar` — the calendar's own read, ui spec §6.1. Everything
 * planned or resolved in `[from, to]`, plus whether generation is currently
 * paused and why.
 */

export interface CalendarDeps {
  readonly db: Db
}

export function makeGetCalendarHandler(deps: CalendarDeps): AccountHandler {
  return async (request, { scope }) => {
    const parsed = calendarQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!parsed.success) {
      return Response.json(
        { error: { code: 'invalid_query', message: 'Provide from and to as YYYY-MM-DD.' } },
        { status: 422 },
      )
    }
    const { from, to } = parsed.data

    const [topics, workGate, lifecycle] = await Promise.all([
      listTopicsInRange(deps.db, scope, from, to),
      mayAccountWorkRun(deps.db, scope.accountId),
      accountLifecycleGate(deps.db, scope.accountId),
    ])

    const topicIds = topics.map((t) => t.id)
    const opportunityIds = [...new Set(topics.map((t) => t.opportunityId))]

    const [articles, gateDecisions, opportunities] = await Promise.all([
      findArticlesByTopics(deps.db, scope, topicIds),
      latestGateDecisionsForTopics(deps.db, scope, topicIds),
      findOpportunitiesByIds(deps.db, scope, opportunityIds),
    ])

    const articleByTopic = new Map<string, ArticleRow>(articles.map((a) => [a.topicId, a]))
    const opportunityById = new Map<string, OpportunityRow>(opportunities.map((o) => [o.id, o]))

    const body = {
      topics: topics.map((t) =>
        serialiseTopic(t, articleByTopic.get(t.id) ?? null, gateDecisions.get(t.id) ?? null, opportunityById.get(t.opportunityId) ?? null),
      ),
      paused: pausedState(workGate, lifecycle),
      // Replenishment (T4.6) does not exist yet, so there is nothing honest to
      // report here — see DECISIONS 2026-09-03 T4.2.
      nextReplenishmentAt: null,
    }

    return Response.json(calendarResponseSchema.parse(body))
  }
}

function serialiseTopic(
  topic: TopicRow,
  article: ArticleRow | null,
  gateDecision: GateDecisionRow | null,
  opportunity: OpportunityRow | null,
) {
  const why = { templateKey: topic.whyLine ?? 'topic.auto', params: {} }

  return {
    id: topic.id,
    title: topic.title,
    scheduledFor: topic.scheduledDate,
    state: topic.state,
    intentClass: topic.intentClass,
    kind: topic.kind,
    source: topic.source,
    pinned: topic.pinned,
    targetKeyword: topic.targetKeyword,
    // `topics` stores no volume of its own (main §13's summary lists none),
    // and joining it live against `keywords` per topic is a query this route
    // does not pay for a field no done-when reads — see DECISIONS
    // 2026-09-03 T4.2.
    monthlySearchVolume: null,
    why,
    opportunityId: topic.opportunityId,
    signalType: opportunity?.signalType ?? null,
    articleId: article?.id ?? null,
    rejection:
      topic.state === 'rejected_by_gate' && gateDecision
        ? {
            gate: (`gate_${gateDecision.gate}` as const),
            reason: {
              templateKey: gateDecision.reasonUserFacing ?? 'gate1.held_insufficient_substance',
              // The values the gate measured, which the sentence has blanks
              // for: the criteria the draft failed and the grader's own written
              // objection. Sending an empty bag here left every quality
              // rejection reading "the reasoning for this one isn't available
              // yet" while the row held both.
              params: reasonParamsOf(gateDecision),
            },
          }
        : null,
  }
}

/**
 * The paused ribbon, ui spec §6.1: one canonical copy regardless of which of
 * "vacation mode / disconnected / kill-switch" is the cause, so this only
 * needs to say *whether* generation is paused, and a short internal reason
 * for anyone reading the response. Shopify-disconnected is not checked here —
 * that state lives on `shopify_conns`, outside this card's read-first
 * sections (main §14.4/§6.2, Lane B's) — see DECISIONS 2026-09-03 T4.2.
 */
function pausedState(
  workGate: WorkGateDecision,
  lifecycle: LifecycleGate,
): { readonly active: boolean; readonly reason: string | null } {
  if (!workGate.allowed) {
    return { active: true, reason: workGate.reason === 'paused' ? `kill_switch:${workGate.flag}` : 'kill_switch_unreadable' }
  }
  if (!lifecycle.generationAllowed) {
    return { active: true, reason: lifecycle.stoppedBy[0] ?? 'paused' }
  }
  return { active: false, reason: null }
}
