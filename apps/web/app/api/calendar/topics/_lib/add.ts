import {
  addTopicRequestSchema,
  addTopicResponseSchema,
  assertEntitled,
  EntitlementInactiveError,
  toIsoDate,
  type ExistingTargetCheck,
  type LlmClient,
  type Logger,
  type PosthogCapture,
} from '@sortiva/core'
import { findTopicOnDate, readLifecycleState, type Db, type TopicRow } from '@sortiva/db'
// Deep import, not the `@sortiva/jobs` barrel — see the identical note in
// `apps/web/app/api/calendar/_lib/handlers.ts`, which hit the build failure
// this avoids.
import { addManualTopic, type AddManualTopicResult } from '@sortiva/jobs/generation/add-manual-topic'
import type { AccountHandler } from '../../../auth/_lib/session'

/**
 * `POST /api/calendar/topics` — the manual-add path in full, main §8.7.
 * `addManualTopic` (`packages/jobs/src/generation`) is the classify-then-Gate-1
 * work; this route only validates the two things Gate 1 cannot (the date, and
 * whether the day is free) before spending a model call on a request that
 * cannot possibly succeed, and turns the result into the frozen wire shape.
 */

export interface AddTopicDeps {
  readonly db: Db
  readonly llm: LlmClient
  readonly prompt: { readonly version: string; readonly text: string }
  readonly existingTargetCheck: ExistingTargetCheck
  readonly now?: () => Date
  readonly logger?: Logger
  readonly capture?: Pick<PosthogCapture, 'capture'>
}

export function makeAddTopicHandler(deps: AddTopicDeps): AccountHandler {
  return async (request, { scope }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return badRequest('Send a JSON body with a title and a date.')
    }
    const parsed = addTopicRequestSchema.safeParse(body)
    if (!parsed.success) return badRequest('A topic needs a title and a date (YYYY-MM-DD).')

    const now = (deps.now ?? (() => new Date()))()
    const today = toIsoDate(now)

    const lifecycle = await readLifecycleState(deps.db, scope)
    try {
      assertEntitled(lifecycle?.subscription ?? null)
    } catch (error) {
      if (error instanceof EntitlementInactiveError) {
        return Response.json({ error: { code: error.code, message: error.message } }, { status: error.httpStatus })
      }
      throw error
    }

    if (parsed.data.date <= today) {
      return conflict('calendar_date_in_past', 'Pick a date in the future.')
    }

    const occupant = await findTopicOnDate(deps.db, scope, parsed.data.date)
    if (occupant) {
      return conflict('calendar_day_occupied', 'That day already has a topic on it.')
    }

    const result = await addManualTopic(
      {
        db: deps.db,
        llm: deps.llm,
        prompt: deps.prompt,
        existingTargetCheck: deps.existingTargetCheck,
        now: () => now,
        ...(deps.logger ? { logger: deps.logger } : {}),
        ...(deps.capture ? { capture: deps.capture } : {}),
      },
      {
        accountId: scope.accountId,
        title: parsed.data.title,
        scheduledDate: parsed.data.date,
        ...(parsed.data.pin !== undefined ? { pinned: parsed.data.pin } : {}),
      },
    )

    return Response.json(addTopicResponseSchema.parse(serialise(result)))
  }
}

function serialise(result: AddManualTopicResult) {
  return {
    outcome: result.outcome,
    topic: result.topic ? serialiseTopic(result.topic) : null,
    warning: result.warning,
    convertedToOpportunityId: result.convertedToOpportunityId,
    rejection: result.rejection,
  }
}

function serialiseTopic(topic: TopicRow) {
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
    why: { templateKey: topic.whyLine ?? 'topic.manual_addition', params: {} },
    opportunityId: topic.opportunityId,
    signalType: null,
    articleId: null,
    rejection: null,
  }
}

function badRequest(message: string): Response {
  return Response.json({ error: { code: 'invalid_body', message } }, { status: 422 })
}

function conflict(code: 'calendar_date_in_past' | 'calendar_day_occupied', message: string): Response {
  return Response.json({ error: { code, message } }, { status: 409 })
}
