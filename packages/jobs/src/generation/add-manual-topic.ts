import {
  classifyManualTopic,
  type ClassifyManualTopicDeps,
  type ExistingTargetCheck,
  type Gate1ReasonCard,
  type Logger,
  type PosthogCapture,
} from '@sortiva/core'
import { accountScope, listFamilies, type Db } from '@sortiva/db'
import { admitManualTopic, type AdmitManualTopicResult } from './admit-manual-topic'
import { runtimeLogger } from '../runtime/logging'

/**
 * `POST /api/calendar/topics` end to end: a merchant's typed title, turned
 * into a `QueryCluster` by one model call, then run through the same Gate 1
 * a scheduled topic gets (`admitManualTopic`).
 *
 * Resolved by the founder on 2026-09-03 — relayed to this session mid-card by
 * a peer integrator session with the founder present — after `T4.1` flagged
 * that nothing in the codebase turned free text into a cluster: one model
 * call, run once per manual add (never across a scan, so it does not carry
 * Gate 1's "~free" requirement). See DECISIONS 2026-09-03 T4.2.
 */

export interface AddManualTopicDeps extends ClassifyManualTopicDeps {
  readonly db: Db
  readonly existingTargetCheck: ExistingTargetCheck
  readonly now?: () => Date
  readonly logger?: Logger
  readonly capture?: Pick<PosthogCapture, 'capture'>
}

export interface AddManualTopicInput {
  readonly accountId: string
  readonly title: string
  readonly scheduledDate: string
  readonly pinned?: boolean
  readonly locale?: string | null
}

/**
 * Reuses `AdmitManualTopicResult`'s shape exactly: from the caller's side of
 * `POST /api/calendar/topics`, a title that failed classification and a
 * title that failed Gate 1 are both just "rejected", with a reason. The
 * degrade-to-pause message for the first (main §14.4, Appendix A's canonical
 * outage copy) rather than the pack of gate-specific templates the second
 * produces.
 */
export type AddManualTopicResult = AdmitManualTopicResult

const CLASSIFICATION_UNAVAILABLE: Gate1ReasonCard = {
  templateKey: 'appendixA.outage',
  params: {},
  retryCondition: 'never',
  redirectUrl: null,
}

export async function addManualTopic(
  deps: AddManualTopicDeps,
  input: AddManualTopicInput,
): Promise<AddManualTopicResult> {
  const log = deps.logger ?? runtimeLogger()
  const scope = accountScope(input.accountId)

  const families = await listFamilies(deps.db, scope)
  const classification = await classifyManualTopic(
    { llm: deps.llm, prompt: deps.prompt },
    { accountId: input.accountId, title: input.title, families: families.map((f) => ({ id: f.id, name: f.name })) },
  )

  if (!classification.ok) {
    // Degrade to pause, never guess — main §14.4. No topic, no gate_decisions
    // row: Gate 1 never ran, because there is nothing yet for it to run on.
    log.warn('topic_classify_failed', { account_id: input.accountId, reason: classification.reason })
    const result: AddManualTopicResult = {
      outcome: 'rejected',
      topic: null,
      warning: null,
      convertedToOpportunityId: null,
      rejection: CLASSIFICATION_UNAVAILABLE,
    }
    return result
  }

  return admitManualTopic(
    {
      db: deps.db,
      existingTargetCheck: deps.existingTargetCheck,
      ...(deps.now ? { now: deps.now } : {}),
      logger: log,
      ...(deps.capture ? { capture: deps.capture } : {}),
    },
    {
      accountId: input.accountId,
      title: input.title,
      cluster: classification.cluster,
      scheduledDate: input.scheduledDate,
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
    },
  )
}
