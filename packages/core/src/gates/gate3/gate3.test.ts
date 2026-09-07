import { describe, expect, it } from 'vitest'
import { rules } from '@sortiva/rules'
import type { LlmClient, LlmRequest, LlmResult } from '../../contracts/llm'
import type { Draft } from '../../generation/draft'
import { lengthTargetFor } from '../../generation/length'
import { runGate3 } from './gate3'
import { claimIdFor, fixturePack, fixturePlan, passingDraft } from './testing'

/**
 * Gate 3's ordering, proved by counting model calls.
 *
 * Three of this card's done-when items are call counts and nothing else,
 * because the ordering is the substance: a draft with a broken table, a
 * missing citation or nothing new to say must be turned down without buying a
 * grading call. Asserting the outcome alone would pass just as happily on an
 * implementation that graded first and checked afterwards.
 */

const config = rules().defaults
const pack = fixturePack()
const plan = fixturePlan(pack)
const length = lengthTargetFor(pack.serp, config.generation.length)

/** Records every request by prompt version, which is how a judge call is told from a contradiction ruling. */
class RecordingLlmClient implements LlmClient {
  readonly requests: LlmRequest[] = []
  constructor(private readonly answers: Record<string, unknown | (() => unknown)>) {}

  countOf(promptVersion: string): number {
    return this.requests.filter((r) => r.promptVersion === promptVersion).length
  }

  async complete<T>(request: LlmRequest): Promise<LlmResult<T>> {
    this.requests.push(request)
    const answer = this.answers[request.promptVersion]
    if (answer === undefined) throw new Error(`no fixture answer for ${request.promptVersion}`)
    const output = typeof answer === 'function' ? (answer as () => unknown)() : answer
    return {
      output: output as T,
      text: JSON.stringify(output),
      modelId: 'claude-sonnet-5',
      promptVersion: request.promptVersion,
      cacheHit: false,
      usage: { inputTokens: 100, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      usdCost: 0.001,
      latencyMs: 1,
      attempts: 1,
    }
  }
}

const JUDGE_PROMPT = { version: 'judge.v1', text: 'grade this' }
const CONTRADICTION_PROMPT = { version: 'contradiction.v1', text: 'rule on these' }

function verdict(overrides: Partial<Record<string, number>> = {}) {
  const scores = {
    informationGain: 4,
    factualGrounding: 4,
    searchIntentMatch: 3,
    actionability: 3,
    languageQuality: 3,
    ecommerceUsefulness: 3,
    ...overrides,
  }
  return {
    scores,
    justifications: Object.fromEntries(Object.keys(scores).map((k) => [k, `because of ${k}`])),
  }
}

function input(draft: Draft) {
  return {
    accountId: 'a1',
    draft,
    plan,
    pack,
    targetKeyword: 'hiking backpacks',
    length,
    internalLinks: [],
    comparisons: [],
    gates: config.gates,
    generation: config.generation,
  }
}

describe('runGate3 — a draft that clears the bar', () => {
  it('passes on one judge call, with no contradiction ruling bought and no repair', async () => {
    const llm = new RecordingLlmClient({ 'judge.v1': verdict() })
    const result = await runGate3({ llm, judgePrompt: JUDGE_PROMPT, contradictionPrompt: CONTRADICTION_PROMPT }, input(passingDraft(plan)))

    expect(result.outcome).toBe('passed')
    expect(result.calls).toEqual({ judge: 1, contradiction: 0, repair: 0 })
    expect(result.verdict?.promptVersion).toBe('judge.v1')
  })
})

describe('runGate3 — the free checks come first', () => {
  it('a draft failing structural validity consumes no judge call (call-count assertion)', async () => {
    const draft = passingDraft(plan)
    const broken: Draft = {
      ...draft,
      sections: [
        ...draft.sections,
        {
          heading: 'Sizes at a glance',
          body: '| Pack | Capacity |\n| --- | --- |\n| The Alpha | 20 | litres |',
        },
      ],
    }

    const llm = new RecordingLlmClient({})
    const result = await runGate3({ llm, judgePrompt: JUDGE_PROMPT, contradictionPrompt: CONTRADICTION_PROMPT }, input(broken))

    expect(result.outcome).toBe('rejected_lint')
    expect(result.calls).toEqual({ judge: 0, contradiction: 0, repair: 0 })
    expect(llm.requests).toHaveLength(0)
    expect(result.lints.issues.map((i) => i.kind)).toContain('ragged_table_row')
  })

  it('a sentence with a number and no citation fails, before anything is graded', async () => {
    const draft = passingDraft(plan)
    const uncited: Draft = {
      ...draft,
      sections: [
        ...draft.sections,
        { heading: 'Weight', body: 'A loaded weekend pack sits at around 12 kg for most walkers.' },
      ],
    }

    const llm = new RecordingLlmClient({})
    const result = await runGate3({ llm, judgePrompt: JUDGE_PROMPT, contradictionPrompt: CONTRADICTION_PROMPT }, input(uncited))

    expect(result.outcome).toBe('rejected_lint')
    expect(llm.requests).toHaveLength(0)
    const citationIssues = result.lints.issues.filter((i) => i.category === 'citations')
    expect(citationIssues.map((i) => i.kind)).toContain('uncited_checkable_content')
    expect(citationIssues[0]!.sentence).toContain('12 kg')
  })

  /**
   * The same uncited figure, written in Danish. The store publishes in Danish,
   * nothing in the product holds a list of Danish words, and the draft is
   * still turned down before a single model call — because a figure has the
   * same shape in every language. This is the half of the citation check that
   * had to survive the word lists being removed.
   */
  it('fails the same uncited figure written in Danish, on the same free check', async () => {
    const draft = passingDraft(plan)
    const uncited: Draft = {
      ...draft,
      sections: [
        ...draft.sections,
        { heading: 'Vægt', body: 'En pakket weekendtaske vejer omkring 12 kg for de fleste vandrere.' },
      ],
    }

    const llm = new RecordingLlmClient({})
    const result = await runGate3({ llm, judgePrompt: JUDGE_PROMPT, contradictionPrompt: CONTRADICTION_PROMPT }, input(uncited))

    expect(result.outcome).toBe('rejected_lint')
    expect(llm.requests).toHaveLength(0)
    const citationIssues = result.lints.issues.filter((i) => i.category === 'citations')
    expect(citationIssues.map((i) => i.kind)).toContain('uncited_checkable_content')
    expect(citationIssues[0]!.sentence).toContain('12 kg')
  })

  /**
   * The bar is now the same one in both languages, which is the whole point of
   * the change: an uncited superlative used to be caught in English and never
   * in Danish. It is caught in neither now — the writing prompt asks for the
   * citation instead — and the two drafts get the identical verdict.
   */
  it('gives an uncited superlative the same verdict in English and in Danish', async () => {
    const withSentence = (heading: string, body: string): Draft => {
      const draft = passingDraft(plan)
      return { ...draft, sections: [...draft.sections, { heading, body }] }
    }

    const english = new RecordingLlmClient({ 'judge.v1': verdict() })
    const danish = new RecordingLlmClient({ 'judge.v1': verdict() })

    const englishResult = await runGate3(
      { llm: english, judgePrompt: JUDGE_PROMPT, contradictionPrompt: CONTRADICTION_PROMPT },
      input(withSentence('Waterproofing', 'This is the most waterproof boot we stock.')),
    )
    const danishResult = await runGate3(
      { llm: danish, judgePrompt: JUDGE_PROMPT, contradictionPrompt: CONTRADICTION_PROMPT },
      input(withSentence('Vandtæthed', 'Dette er den mest vandtætte støvle vi har.')),
    )

    expect(danishResult.outcome).toBe(englishResult.outcome)
    expect(danishResult.calls).toEqual(englishResult.calls)
    expect(danishResult.lints.issues.map((i) => i.kind)).toEqual(englishResult.lints.issues.map((i) => i.kind))
  })

  it('a draft leaking our own vocabulary into the body fails structurally', async () => {
    const draft = passingDraft(plan)
    const leaked: Draft = {
      ...draft,
      sections: [...draft.sections, { heading: 'Notes', body: 'Drawn from the evidence pack assembled for this topic.' }],
    }

    const llm = new RecordingLlmClient({})
    const result = await runGate3({ llm, judgePrompt: JUDGE_PROMPT, contradictionPrompt: CONTRADICTION_PROMPT }, input(leaked))

    expect(result.outcome).toBe('rejected_lint')
    expect(result.lints.issues.map((i) => i.kind)).toContain('internal_metadata_leaked')
  })
})

describe('runGate3 — the document must not contradict itself', () => {
  /**
   * The case `docs/content-pointers.md` §8 names: two thresholds about the
   * same thing, stated differently in two places. Each sentence is fine on its
   * own, which is exactly why no sentence-level check catches it — and both
   * are properly cited to claims that really do carry those figures, so the
   * pair reaches the contradiction pass rather than dying at the free checks.
   */
  const contradictionPlan = {
    ...plan,
    claims: [
      ...plan.claims,
      {
        id: 'r2',
        text: 'Carrying above 300 kg on the trailer calls for the reinforced frame.',
        kind: 'recommendation' as const,
        confidence: 'medium' as const,
        evidence: [{ kind: 'claim' as const, claimRef: claimIdFor(plan, 'p-alpha', 'material') }],
      },
      {
        id: 'r3',
        text: 'The reinforced frame is called for above 200 kg on the trailer.',
        kind: 'recommendation' as const,
        confidence: 'medium' as const,
        evidence: [{ kind: 'claim' as const, claimRef: claimIdFor(plan, 'p-alpha', 'material') }],
      },
    ],
  }

  function contradictoryDraft(): Draft {
    const draft = passingDraft(plan)
    return {
      ...draft,
      sections: [
        ...draft.sections,
        {
          heading: 'When the reinforced frame is worth it',
          body: 'Carrying above 300 kg on the trailer calls for the reinforced frame[[r2]].',
        },
        {
          heading: 'Trailer loads',
          body: 'The reinforced frame is called for above 200 kg on the trailer[[r3]].',
        },
      ],
    }
  }

  function contradictionInput(): ReturnType<typeof input> {
    return { ...input(contradictoryDraft()), plan: contradictionPlan }
  }

  it('groups the pair deterministically and fails when the model rules it a contradiction', async () => {
    const llm = new RecordingLlmClient({
      'contradiction.v1': { verdicts: [{ index: 0, ruling: 'contradiction', explanation: 'nothing distinguishes the two cases' }] },
      'judge.v1': verdict(),
    })
    const result = await runGate3({ llm, judgePrompt: JUDGE_PROMPT, contradictionPrompt: CONTRADICTION_PROMPT }, contradictionInput())

    expect(result.outcome).toBe('rejected_contradiction')
    expect(result.conflicts).toHaveLength(1)
    // One ruling bought, and the judge never reached — the draft was turned
    // down before the expensive call.
    expect(result.calls).toEqual({ judge: 0, contradiction: 1, repair: 0 })
    expect(llm.countOf('judge.v1')).toBe(0)
  })

  it('passes the same pair when the model says the two statements are scoped differently', async () => {
    const llm = new RecordingLlmClient({
      'contradiction.v1': { verdicts: [{ index: 0, ruling: 'scoped_differently', explanation: 'different ranges' }] },
      'judge.v1': verdict(),
    })
    const result = await runGate3({ llm, judgePrompt: JUDGE_PROMPT, contradictionPrompt: CONTRADICTION_PROMPT }, contradictionInput())

    expect(result.outcome).toBe('passed')
    expect(result.calls).toEqual({ judge: 1, contradiction: 1, repair: 0 })
  })
})

describe('runGate3 — the judge, the floors and the single repair loop', () => {
  it('fails a 5/5/5/1/5 draft: the gate is on the minimum, never the average', async () => {
    const llm = new RecordingLlmClient({
      'judge.v1': verdict({
        informationGain: 5,
        factualGrounding: 5,
        searchIntentMatch: 5,
        actionability: 1,
        languageQuality: 5,
        ecommerceUsefulness: 5,
      }),
    })
    let repairs = 0
    const result = await runGate3(
      {
        llm,
        judgePrompt: JUDGE_PROMPT,
        contradictionPrompt: CONTRADICTION_PROMPT,
        repairWriter: async ({ previousDraft }) => {
          repairs += 1
          return previousDraft
        },
      },
      input(passingDraft(plan)),
    )

    // The average of those six scores is well above every floor; the minimum
    // is not, and the minimum is what decides.
    expect(result.passed).toBe(false)
    expect(result.evaluation?.failed.map((f) => f.criterion)).toEqual(['actionability'])
    expect(repairs).toBe(1)
  })

  it('reports a judge failure with the repair loop turned off as exactly that, not as a repair that happened', async () => {
    const llm = new RecordingLlmClient({ 'judge.v1': verdict({ actionability: 2 }) })
    const result = await runGate3(
      { llm, judgePrompt: JUDGE_PROMPT, contradictionPrompt: CONTRADICTION_PROMPT },
      input(passingDraft(plan)),
    )

    expect(result.outcome).toBe('rejected_judge')
    expect(result.repaired).toBe(false)
    expect(result.calls).toEqual({ judge: 1, contradiction: 0, repair: 0 })
  })

  it('a draft failing only information gain is rejected with zero repair calls (call-count assertion)', async () => {
    const llm = new RecordingLlmClient({ 'judge.v1': verdict({ informationGain: 2 }) })
    let repairs = 0
    const result = await runGate3(
      {
        llm,
        judgePrompt: JUDGE_PROMPT,
        contradictionPrompt: CONTRADICTION_PROMPT,
        repairWriter: async ({ previousDraft }) => {
          repairs += 1
          return previousDraft
        },
      },
      input(passingDraft(plan)),
    )

    expect(result.outcome).toBe('rejected_no_information_gain')
    expect(result.reasonTemplateKey).toBe('gate3.no_information_gain')
    expect(result.repaired).toBe(false)
    // No rewrite adds material the research never gathered, so the repair call
    // is not spent — founder decision, 2026-09-01.
    expect(repairs).toBe(0)
    expect(result.calls).toEqual({ judge: 1, contradiction: 0, repair: 0 })
    expect(llm.countOf('judge.v1')).toBe(1)
  })

  it('a second regrade failure ends in rejection with no third loop (call-count assertion)', async () => {
    const llm = new RecordingLlmClient({ 'judge.v1': () => verdict({ actionability: 2 }) })
    let repairs = 0
    const result = await runGate3(
      {
        llm,
        judgePrompt: JUDGE_PROMPT,
        contradictionPrompt: CONTRADICTION_PROMPT,
        repairWriter: async ({ previousDraft }) => {
          repairs += 1
          return previousDraft
        },
      },
      input(passingDraft(plan)),
    )

    expect(result.outcome).toBe('rejected_after_repair')
    expect(result.repaired).toBe(true)
    // Exactly two gradings and one rewrite. A third of either would be the
    // loop this gate refuses to run.
    expect(result.calls).toEqual({ judge: 2, contradiction: 0, repair: 1 })
    expect(repairs).toBe(1)
    expect(llm.countOf('judge.v1')).toBe(2)
  })

  it('passes when the repaired draft clears the bar on its regrade', async () => {
    const answers = [verdict({ actionability: 2 }), verdict()]
    const llm = new RecordingLlmClient({ 'judge.v1': () => answers.shift()! })
    const result = await runGate3(
      {
        llm,
        judgePrompt: JUDGE_PROMPT,
        contradictionPrompt: CONTRADICTION_PROMPT,
        repairWriter: async ({ previousDraft, instructions }) => {
          // The judge's own words are what the writer is given back.
          expect(instructions).toContain('actionability')
          expect(instructions).toContain('because of actionability')
          return previousDraft
        },
      },
      input(passingDraft(plan)),
    )

    expect(result.outcome).toBe('passed')
    expect(result.repaired).toBe(true)
    expect(result.calls).toEqual({ judge: 2, contradiction: 0, repair: 1 })
  })

  it('rejects without a regrade when the repaired draft breaks a free check', async () => {
    const llm = new RecordingLlmClient({ 'judge.v1': verdict({ actionability: 2 }) })
    const result = await runGate3(
      {
        llm,
        judgePrompt: JUDGE_PROMPT,
        contradictionPrompt: CONTRADICTION_PROMPT,
        repairWriter: async ({ previousDraft }) => ({
          ...previousDraft,
          sections: [
            ...previousDraft.sections,
            { heading: 'Weight', body: 'A loaded pack sits at around 12 kg.' },
          ],
        }),
      },
      input(passingDraft(plan)),
    )

    expect(result.outcome).toBe('rejected_after_repair')
    expect(result.calls).toEqual({ judge: 1, contradiction: 0, repair: 1 })
  })
})
