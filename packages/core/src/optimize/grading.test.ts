import { describe, expect, it } from 'vitest'
import { rules } from '@sortiva/rules'
import type { JudgeLite, JudgeVerdict } from '../contracts/opportunities'
import { evaluateOptimizeFloors, gradeRecommendation, gradingEvidence } from './grading'
import { fixturePack, fixtureRecommendation } from './testing/fixture'

/** Main §10.3 step 5: two criteria, both at their floor, gated on the minimum. */

const config = rules().defaults.gates.optimize_recommendation

function verdict(scores: Record<string, number>): JudgeVerdict {
  return {
    passed: true,
    scores: scores as JudgeVerdict['scores'],
    justifications: {},
    promptVersion: 'optimize-judge.v1',
    modelId: 'claude-sonnet-5',
  }
}

class RecordingJudge implements JudgeLite {
  readonly seen: { recommendation: unknown; pack: unknown }[] = []

  constructor(private readonly scores: Record<string, number>) {}

  async grade(recommendation: unknown, pack: unknown): Promise<JudgeVerdict> {
    this.seen.push({ recommendation, pack })
    return verdict(this.scores)
  }
}

describe('OPTIMIZE grading', () => {
  it('passes only when both criteria clear their own floor', () => {
    const result = evaluateOptimizeFloors(verdict({ factualGrounding: 4, searchIntentMatch: 4 }), config)
    expect(result.passed).toBe(true)
    expect(result.outcomes.map((o) => o.floor)).toEqual([config.grounding_min, config.intent_match_min])
  })

  it('fails an intent-match score the article gate would have passed at 3', () => {
    const result = evaluateOptimizeFloors(
      // `passed: true` on the verdict is the article floors' answer; this is
      // the check that we do not take it.
      verdict({ factualGrounding: 5, searchIntentMatch: 3 }),
      config,
    )

    expect(result.passed).toBe(false)
    expect(result.failed.map((o) => o.criterion)).toEqual(['searchIntentMatch'])
  })

  it('treats a missing criterion as a failure rather than a pass', () => {
    const result = evaluateOptimizeFloors(verdict({ factualGrounding: 5 }), config)
    expect(result.failed.map((o) => o.criterion)).toEqual(['searchIntentMatch'])
  })

  it('shows the grader the suggestions and the evidence, and no page body', () => {
    const evidence = gradingEvidence(fixturePack())
    const serialised = JSON.stringify(evidence)

    expect(evidence['search']).toBe('trail running shoes for wide feet')
    expect(serialised).toContain('how to measure forefoot width')
    expect(serialised).toContain('Ridge 2E')
    expect(serialised).not.toContain('built for runners who need more room')
  })

  it('grades through the JudgeLite seam', async () => {
    const judge = new RecordingJudge({ factualGrounding: 4, searchIntentMatch: 5 })
    const result = await gradeRecommendation(judge, fixtureRecommendation(), fixturePack(), config)

    expect(result.passed).toBe(true)
    expect(judge.seen).toHaveLength(1)
    expect(judge.seen[0]?.recommendation).toEqual(fixtureRecommendation())
  })
})
