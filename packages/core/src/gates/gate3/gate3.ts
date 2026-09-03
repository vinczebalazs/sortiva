import type { GatesConfig, GenerationConfig } from '@sortiva/rules'
import type { LlmClient } from '../../contracts/llm'
import type { JudgeVerdict } from '../../contracts/opportunities'
import type { ClaimPlan } from '../../generation/claims'
import type { Draft } from '../../generation/draft'
import type { EvidencePack } from '../../generation/evidence-pack'
import type { InternalLinkTarget } from '../../generation/internal-links'
import type { LengthTarget } from '../../generation/length'
import { lexiconFor } from './checkable'
import {
  checkContradictions,
  type CandidateConflict,
  type ContradictionPrompt,
} from './contradictions'
import type { ComparisonText } from './duplication'
import { evaluateFloors, gradeDraft, type FloorEvaluation, type JudgePrompt } from './judge'
import { runLints, type LintIssue, type LintResult } from './lints'
import { revisionInstructions } from './repair'

/**
 * Gate 3, end to end, in the order the ordering itself is the point:
 *
 * 1. **Every free check first.** Structure, citations, assertion strength,
 *    volatile values, length, links, stuffing, near-duplication. A draft that
 *    fails any of them is rejected having cost nothing.
 * 2. **The contradiction pass**, which is free until it finds a genuine
 *    candidate conflict and only then asks a model to rule on it.
 * 3. **The blind judge**, and only then.
 *
 * On failure there is **exactly one** repair attempt, with one exception that
 * is a founder decision rather than an implementation detail: a draft that
 * fails **information gain** is rejected on the spot with no repair. The other
 * criteria fail for reasons a rewrite can fix; information gain fails because
 * the research turned up nothing distinctive, and rewriting cannot add
 * material that was never gathered. Spending the repair call there buys a
 * second draft that says the same nothing.
 *
 * After a repair the free checks run again — a revision can break a table
 * that the first draft got right — and a second failure ends the run. There
 * is no third attempt anywhere in this file.
 */

export type Gate3Outcome =
  | 'passed'
  | 'rejected_lint'
  | 'rejected_contradiction'
  | 'rejected_no_information_gain'
  /** Failed the judge with no repair available — a configuration with the loop turned off. */
  | 'rejected_judge'
  | 'rejected_after_repair'

export interface Gate3ModelCalls {
  readonly judge: number
  readonly contradiction: number
  readonly repair: number
}

export interface Gate3Result {
  readonly outcome: Gate3Outcome
  readonly passed: boolean
  /** The draft that was graded last — the repaired one when a repair happened. */
  readonly draft: Draft
  readonly repaired: boolean
  readonly lints: LintResult
  readonly verdict: JudgeVerdict | null
  readonly evaluation: FloorEvaluation | null
  readonly conflicts: readonly { readonly candidate: CandidateConflict; readonly explanation: string }[]
  readonly calls: Gate3ModelCalls
  /** Keyed copy for the merchant's reason card; null when the draft passed. */
  readonly reasonTemplateKey: string | null
  readonly reasonParams: Readonly<Record<string, string | number>>
  /** Everything worth keeping on the `gate_decisions` row. */
  readonly audit: Readonly<Record<string, unknown>>
}

/** What the writer needs to produce a revision. Supplied by the caller so Gate 3 never builds a writer call itself. */
export type RepairWriter = (input: {
  readonly previousDraft: Draft
  readonly instructions: string
  readonly verdict: JudgeVerdict
  readonly evaluation: FloorEvaluation
  readonly lintIssues: readonly LintIssue[]
}) => Promise<Draft>

export interface Gate3Deps {
  readonly llm: LlmClient
  readonly judgePrompt: JudgePrompt
  readonly contradictionPrompt: ContradictionPrompt
  /** Absent means no repair is possible; the run then ends at the first failure. */
  readonly repairWriter?: RepairWriter
}

export interface Gate3Input {
  readonly accountId: string
  readonly draft: Draft
  readonly plan: ClaimPlan
  readonly pack: EvidencePack
  readonly targetKeyword: string
  readonly length: LengthTarget
  readonly internalLinks: readonly InternalLinkTarget[]
  readonly comparisons: readonly ComparisonText[]
  /** The article's language, which decides whether the word-list checks can run. */
  readonly languageCode: string | null
  readonly gates: GatesConfig
  readonly generation: GenerationConfig
}

function lintReason(lints: LintResult): { key: string; params: Record<string, string | number> } {
  return {
    key: `gate3.${lints.failedCategory ?? 'lint'}`,
    params: {
      issue_count: lints.issues.length,
      first_location: lints.issues[0]?.location ?? '',
      first_detail: lints.issues[0]?.detail ?? '',
    },
  }
}

function auditOf(
  lints: LintResult,
  evaluation: FloorEvaluation | null,
  verdict: JudgeVerdict | null,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    lint_issues: lints.issues,
    word_count: lints.wordCount,
    keyword_density: lints.keywordDensity,
    highest_similarity: lints.highestSimilarity,
    scores: verdict?.scores ?? null,
    justifications: verdict?.justifications ?? null,
    failed_criteria: evaluation?.failed.map((o) => o.criterion) ?? [],
    ...extra,
  }
}

export async function runGate3(deps: Gate3Deps, input: Gate3Input): Promise<Gate3Result> {
  const lexicon = lexiconFor(input.languageCode)
  const calls = { judge: 0, contradiction: 0, repair: 0 }

  const lintFor = (draft: Draft): LintResult =>
    runLints({
      draft,
      plan: input.plan,
      pack: input.pack,
      targetKeyword: input.targetKeyword,
      length: input.length,
      internalLinks: input.internalLinks,
      comparisons: input.comparisons,
      lexicon,
      gates: input.gates,
      generation: input.generation,
    })

  // ---- 1. The free checks. Nothing below this point runs if they fail. ----
  const lints = lintFor(input.draft)
  if (!lints.passed) {
    const reason = lintReason(lints)
    return {
      outcome: 'rejected_lint',
      passed: false,
      draft: input.draft,
      repaired: false,
      lints,
      verdict: null,
      evaluation: null,
      conflicts: [],
      calls,
      reasonTemplateKey: reason.key,
      reasonParams: reason.params,
      audit: auditOf(lints, null, null, { language_checks_ran: lexicon !== null }),
    }
  }

  // ---- 2. Contradictions: free to find, paid only to adjudicate. ----
  const contradictions = await checkContradictions(
    { llm: deps.llm, prompt: deps.contradictionPrompt },
    { accountId: input.accountId, draft: input.draft, lexicon, config: input.gates.draft_lints },
  )
  calls.contradiction += contradictions.modelCalls

  if (!contradictions.passed) {
    return {
      outcome: 'rejected_contradiction',
      passed: false,
      draft: input.draft,
      repaired: false,
      lints,
      verdict: null,
      evaluation: null,
      conflicts: contradictions.contradictions,
      calls,
      reasonTemplateKey: 'gate3.contradiction',
      reasonParams: {
        conflict_count: contradictions.contradictions.length,
        first_detail: contradictions.contradictions[0]?.explanation ?? '',
      },
      audit: auditOf(lints, null, null, {
        contradictions: contradictions.contradictions,
        candidate_count: contradictions.candidates.length,
        contradiction_prompt_version: contradictions.promptVersion,
        contradiction_model_id: contradictions.modelId,
        language_checks_ran: lexicon !== null,
      }),
    }
  }

  // ---- 3. The judge. ----
  const first = await gradeDraft(
    { llm: deps.llm },
    {
      prompt: deps.judgePrompt,
      accountId: input.accountId,
      targetKeyword: input.targetKeyword,
      draft: input.draft,
      pack: input.pack,
    },
    input.gates.draft_grading,
  )
  calls.judge += 1

  if (first.evaluation.passed) {
    return {
      outcome: 'passed',
      passed: true,
      draft: input.draft,
      repaired: false,
      lints,
      verdict: first.verdict,
      evaluation: first.evaluation,
      conflicts: [],
      calls,
      reasonTemplateKey: null,
      reasonParams: {},
      audit: auditOf(lints, first.evaluation, first.verdict, { language_checks_ran: lexicon !== null }),
    }
  }

  // A draft with nothing new to say is rejected outright: the repair attempt
  // is not spent, because no rewrite adds material the research never
  // gathered. Founder decision, 2026-09-01 (`DECISIONS.md`).
  if (first.evaluation.informationGainFailed || !deps.repairWriter || input.gates.draft_grading.repair_loops_max < 1) {
    return {
      // Not `rejected_after_repair`: no repair was attempted here, and the
      // outcome string is what lands on the audit row.
      outcome: first.evaluation.informationGainFailed ? 'rejected_no_information_gain' : 'rejected_judge',
      passed: false,
      draft: input.draft,
      repaired: false,
      lints,
      verdict: first.verdict,
      evaluation: first.evaluation,
      conflicts: [],
      calls,
      reasonTemplateKey: first.evaluation.informationGainFailed
        ? 'gate3.no_information_gain'
        : 'gate3.below_quality_bar',
      reasonParams: {
        failed_criteria: first.evaluation.failed.map((o) => o.criterion).join(', '),
        first_justification: first.verdict.justifications[first.evaluation.failed[0]?.criterion ?? ''] ?? '',
      },
      audit: auditOf(lints, first.evaluation, first.verdict, {
        repair_attempted: false,
        language_checks_ran: lexicon !== null,
      }),
    }
  }

  // ---- The single repair loop. ----
  const repaired = await deps.repairWriter({
    previousDraft: input.draft,
    instructions: revisionInstructions({ verdict: first.verdict, evaluation: first.evaluation }),
    verdict: first.verdict,
    evaluation: first.evaluation,
    lintIssues: [],
  })
  calls.repair += 1

  const repairedLints = lintFor(repaired)
  if (!repairedLints.passed) {
    const reason = lintReason(repairedLints)
    return {
      outcome: 'rejected_after_repair',
      passed: false,
      draft: repaired,
      repaired: true,
      lints: repairedLints,
      verdict: first.verdict,
      evaluation: first.evaluation,
      conflicts: [],
      calls,
      reasonTemplateKey: reason.key,
      reasonParams: reason.params,
      audit: auditOf(repairedLints, first.evaluation, first.verdict, {
        repair_attempted: true,
        repair_failed_on: 'lints',
        language_checks_ran: lexicon !== null,
      }),
    }
  }

  const second = await gradeDraft(
    { llm: deps.llm },
    {
      prompt: deps.judgePrompt,
      accountId: input.accountId,
      targetKeyword: input.targetKeyword,
      draft: repaired,
      pack: input.pack,
    },
    input.gates.draft_grading,
  )
  calls.judge += 1

  return {
    outcome: second.evaluation.passed ? 'passed' : 'rejected_after_repair',
    passed: second.evaluation.passed,
    draft: repaired,
    repaired: true,
    lints: repairedLints,
    verdict: second.verdict,
    evaluation: second.evaluation,
    conflicts: [],
    calls,
    reasonTemplateKey: second.evaluation.passed ? null : 'gate3.below_quality_bar',
    reasonParams: second.evaluation.passed
      ? {}
      : {
          failed_criteria: second.evaluation.failed.map((o) => o.criterion).join(', '),
          first_justification: second.verdict.justifications[second.evaluation.failed[0]?.criterion ?? ''] ?? '',
        },
    audit: auditOf(repairedLints, second.evaluation, second.verdict, {
      repair_attempted: true,
      first_scores: first.verdict.scores,
      language_checks_ran: lexicon !== null,
    }),
  }
}

export { evaluateFloors }
