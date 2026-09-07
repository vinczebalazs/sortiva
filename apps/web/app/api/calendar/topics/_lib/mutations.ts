import {
  moveTopicRequestSchema,
  pinTopicRequestSchema,
  topicSchema,
  type ConflictCode,
} from '@sortiva/core'
import { findOpportunityById, findTopic, type AccountScope, type Db, type OpportunityRow } from '@sortiva/db'
// Deep imports, not the `@sortiva/jobs` barrel — see the identical note in
// `apps/web/app/api/calendar/_lib/handlers.ts`, which hit the build failure
// this avoids.
import { moveTopic } from '@sortiva/jobs/generation/move-topic'
import { pinTopic } from '@sortiva/jobs/generation/pin-topic'
import { vetoTopic } from '@sortiva/jobs/generation/veto-topic'
import type { AccountHandler } from '../../../auth/_lib/session'
import { calendarWhyLine } from '../../_lib/why'

/**
 * Veto, move and pin — the three guarded mutations on an existing topic,
 * main §8.7. Each is a thin parse → call `packages/jobs/src/generation` →
 * serialise; the state machine and the conflict-code mapping live there and
 * in `packages/core/src/calendar`, not here.
 */

export interface TopicMutationDeps {
  readonly db: Db
  readonly now?: () => Date
}

export type RouteCtx = { readonly params: Promise<{ topicId: string }> }

const CONFLICT_MESSAGES: Partial<Record<ConflictCode, string>> = {
  topic_already_published: 'This topic has already resolved and can no longer be changed.',
  topic_already_generating: 'This topic already started generating.',
  topic_pinned: 'That day is pinned and cannot be displaced.',
  calendar_date_in_past: 'Pick a date in the future.',
}

function conflict(code: ConflictCode): Response {
  return Response.json(
    { error: { code, message: CONFLICT_MESSAGES[code] ?? 'That change could not be made.' } },
    { status: 409 },
  )
}

function notFound(): Response {
  return Response.json(
    { error: { code: 'topic_not_found', message: 'That topic is gone.' } },
    { status: 404 },
  )
}

export function makeVetoTopicHandler(deps: TopicMutationDeps): AccountHandler<RouteCtx> {
  return async (_request, { scope, route }) => {
    const { topicId } = await route.params
    const existing = await findTopic(deps.db, scope, topicId)
    if (!existing) return notFound()

    const result = await vetoTopic({ db: deps.db, ...(deps.now ? { now: deps.now } : {}) }, { accountId: scope.accountId, topicId })
    if (!result.ok) return conflict(result.code)
    return Response.json({ ok: true })
  }
}

export function makeMoveTopicHandler(deps: TopicMutationDeps): AccountHandler<RouteCtx> {
  return async (request, { scope, route }) => {
    const { topicId } = await route.params
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return Response.json({ error: { code: 'invalid_body', message: 'Expected a JSON body with a date.' } }, { status: 422 })
    }
    const parsed = moveTopicRequestSchema.safeParse(body)
    if (!parsed.success) {
      return Response.json({ error: { code: 'invalid_body', message: 'Provide a date as YYYY-MM-DD.' } }, { status: 422 })
    }

    const result = await moveTopic(
      { db: deps.db, ...(deps.now ? { now: deps.now } : {}) },
      { accountId: scope.accountId, topicId, toDate: parsed.data.date },
    )
    if (!result.ok) return result.code === 'not_found' ? notFound() : conflict(result.code)
    return Response.json(topicSchema.parse(await serialiseTopicForResponse(deps.db, scope, result.topic)))
  }
}

export function makePinTopicHandler(deps: TopicMutationDeps): AccountHandler<RouteCtx> {
  return async (request, { scope, route }) => {
    const { topicId } = await route.params
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return Response.json({ error: { code: 'invalid_body', message: 'Expected a JSON body with pinned.' } }, { status: 422 })
    }
    const parsed = pinTopicRequestSchema.safeParse(body)
    if (!parsed.success) {
      return Response.json({ error: { code: 'invalid_body', message: 'Provide pinned as a boolean.' } }, { status: 422 })
    }

    const result = await pinTopic(
      { db: deps.db, ...(deps.now ? { now: deps.now } : {}) },
      { accountId: scope.accountId, topicId, pinned: parsed.data.pinned },
    )
    if (!result.ok) return result.code === 'not_found' ? notFound() : conflict(result.code)
    return Response.json(topicSchema.parse(await serialiseTopicForResponse(deps.db, scope, result.topic)))
  }
}

/**
 * `topicSchema` carries fields (`signalType`, `articleId`,
 * `monthlySearchVolume`, `rejection`) a move/pin response has no reason to
 * re-fetch — the merchant dragged or pinned a chip they can already see, and
 * this response's whole job is confirming where it landed. Filled with the
 * same "nothing new to say" defaults `GET /api/calendar` uses for the fields
 * it cannot cheaply answer either.
 *
 * `why` is not among them. The moved chip is re-rendered from this response, so
 * a placeholder here replaces a filled sentence on screen the moment a merchant
 * drags a day — which is why the opportunity behind it is read back, the one
 * extra query this response pays for.
 */
async function serialiseTopicForResponse(
  db: Db,
  scope: AccountScope,
  topic: Awaited<ReturnType<typeof findTopic>>,
) {
  if (!topic) throw new Error('serialiseTopicForResponse called with no topic')
  const opportunity: OpportunityRow | null =
    (await findOpportunityById(db, scope, topic.opportunityId)) ?? null
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
    monthlySearchVolume: null,
    why: calendarWhyLine(topic.whyLine, opportunity, 'topic.auto'),
    opportunityId: topic.opportunityId,
    signalType: null,
    articleId: null,
    rejection: null,
  }
}
