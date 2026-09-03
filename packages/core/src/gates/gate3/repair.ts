import { buildDraftRequest, type BuildDraftRequestInput, type Draft, type DraftPrompt } from '../../generation/draft'
import type { LlmRequest } from '../../contracts/llm'
import type { LintIssue } from './lints'
import type { FloorEvaluation } from './judge'
import type { JudgeVerdict } from '../../contracts/opportunities'

/**
 * The one repair attempt.
 *
 * The judge's own written justifications go back to the writer as revision
 * instructions — not a score, not "try again", but the sentences explaining
 * what fell short, on the criteria that actually fell short. The writer keeps
 * its original brief (the approved claims, the section shape, the length
 * target) so the rewrite is a revision rather than a fresh article that would
 * have to be re-grounded from scratch.
 *
 * There is exactly one of these per draft, and the reason is in
 * `docs/content-pointers.md` §7: a second repair on a draft that failed
 * grounding twice is not converging on truth, it is searching for phrasing
 * that evades the check.
 */

export interface RepairInstructionsInput {
  readonly verdict: JudgeVerdict
  readonly evaluation: FloorEvaluation
  /** Free-check failures found on the graded draft, if any reached this point. */
  readonly lintIssues?: readonly LintIssue[]
}

export function revisionInstructions(input: RepairInstructionsInput): string {
  const lines: string[] = ['Revise the article below. It did not meet the quality bar on these points:']

  for (const outcome of input.evaluation.failed) {
    const justification = input.verdict.justifications[outcome.criterion] ?? '(no justification recorded)'
    lines.push(`- ${outcome.criterion} (scored ${outcome.score}, needs ${outcome.floor}): ${justification}`)
  }

  for (const issue of input.lintIssues ?? []) {
    lines.push(`- ${issue.category} — ${issue.location}: ${issue.detail}`)
  }

  lines.push(
    '',
    'Keep everything that was already right. Do not add any claim that is not in the approved list you were given, ' +
      'and keep every citation marker attached to the sentence it supports.',
  )
  return lines.join('\n')
}

export interface BuildRepairRequestInput {
  readonly draftInput: BuildDraftRequestInput
  readonly revisePrompt: DraftPrompt
  readonly previousDraft: Draft
  readonly instructions: string
}

/**
 * The revision call. It is a `draft` call — it is the writer working, and its
 * spend belongs with the writer's — carrying its own prompt version so a
 * revision is never mistaken for a first attempt when the artefacts are read
 * back later.
 */
export function buildRepairRequest(input: BuildRepairRequestInput): LlmRequest {
  const original = buildDraftRequest({ ...input.draftInput, prompt: input.revisePrompt })

  return {
    ...original,
    promptVersion: input.revisePrompt.version,
    system: input.revisePrompt.text,
    messages: [
      ...original.messages,
      { role: 'assistant', content: JSON.stringify(input.previousDraft) },
      { role: 'user', content: input.instructions },
    ],
  }
}
