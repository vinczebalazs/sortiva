import {
  OVERRIDE_GATE_OUTCOME,
  overrideConflictFor,
  type ConflictCode,
  type Logger,
  type OverrideAudit,
} from '@sortiva/core'
import {
  accountScope,
  findArticleById,
  findLatestGateDecisionForTopic,
  insertGateDecision,
  markArticleOverridden,
  type ArticleRow,
  type Db,
} from '@sortiva/db'
import { runtimeLogger } from '../runtime/logging'

/**
 * "Publish anyway" — the merchant overrules a draft the quality bar turned
 * down. It is their site.
 *
 * What it does, and what it deliberately does not:
 *
 * - The article moves into the one state that means a person cleared it to go
 *   out, and is handed over at the store's own publishing hour like anything
 *   else. Nothing is posted from inside this request.
 * - It carries the override flag for the rest of its life, which is what keeps
 *   it out of the data the quality bar is tuned on, out of pattern learning,
 *   and out of any claim we make about how our articles perform.
 * - It never goes to draft review. A merchant who has just overruled the
 *   quality bar has already made the decision review exists to ask for.
 * - The move is guarded to a draft that was actually rejected. Overriding
 *   anything else is overriding a decision that was never made, so it is
 *   refused rather than quietly performed — an override endpoint that
 *   publishes whatever it is handed is worse than none.
 */

export interface OverrideArticleDeps {
  readonly db: Db
  readonly now?: () => Date
  readonly logger?: Logger
}

export interface OverrideArticleInput {
  readonly accountId: string
  readonly articleId: string
  /** The criteria the confirmation dialog restated, kept as what the merchant was actually shown. */
  readonly acknowledgedCriteria: readonly string[]
}

export type OverrideArticleResult =
  | { readonly ok: true; readonly article: ArticleRow }
  | { readonly ok: false; readonly code: ConflictCode }
  | { readonly ok: false; readonly code: 'not_found' }

function failedCriteriaOf(audit: unknown): readonly string[] {
  if (!audit || typeof audit !== 'object') return []
  const failed = (audit as { failed_criteria?: unknown }).failed_criteria
  if (!Array.isArray(failed)) return []
  return failed.filter((entry): entry is string => typeof entry === 'string')
}

function scoresOf(audit: unknown): Readonly<Record<string, number>> | null {
  if (!audit || typeof audit !== 'object') return null
  const scores = (audit as { scores?: unknown }).scores
  if (!scores || typeof scores !== 'object') return null
  const out: Record<string, number> = {}
  for (const [criterion, value] of Object.entries(scores as Record<string, unknown>)) {
    if (typeof value === 'number') out[criterion] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

export async function publishAnyway(
  deps: OverrideArticleDeps,
  input: OverrideArticleInput,
): Promise<OverrideArticleResult> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(input.accountId)

  const existing = await findArticleById(deps.db, scope, input.articleId)
  if (!existing) return { ok: false, code: 'not_found' }

  // Read before the move: the refusal being overruled is what the audit row
  // has to name, and the override writes a decision of its own on top of it.
  const rejection = await findLatestGateDecisionForTopic(deps.db, scope, existing.topicId, [3])

  const overridden = await markArticleOverridden(deps.db, scope, input.articleId, now)
  // Zero rows means the article is not a rejected draft — it was never held
  // back, or it moved while the merchant was looking at it. Refuse rather than
  // force the state.
  if (!overridden) return { ok: false, code: overrideConflictFor(existing.state) }

  const audit: OverrideAudit = {
    overriddenAt: now.toISOString(),
    // What the gate itself recorded, not what the browser sent: the request
    // says what the merchant was shown, and the two are worth keeping apart.
    failedCriteria: failedCriteriaOf(rejection?.scoresJson),
    scores: scoresOf(rejection?.scoresJson),
    // The row already names the account, and an account is one login here, so
    // a second copy of the same id would say nothing further.
    actorUserId: null,
  }

  await insertGateDecision(
    deps.db,
    scope,
    {
      topicId: existing.topicId,
      gate: 3,
      outcome: OVERRIDE_GATE_OUTCOME,
      scoresJson: { ...audit, acknowledged_criteria: [...input.acknowledgedCriteria] },
      // The reason card belongs to the refusal, not to the merchant's answer
      // to it; the refusal's own row still carries it.
      reasonUserFacing: null,
      promptVersion: rejection?.promptVersion ?? null,
      modelId: rejection?.modelId ?? null,
    },
    now,
  )

  log.info('article_override_published', {
    account_id: input.accountId,
    article_id: overridden.id,
    failed_criteria: audit.failedCriteria.length,
  })
  return { ok: true, article: overridden }
}
