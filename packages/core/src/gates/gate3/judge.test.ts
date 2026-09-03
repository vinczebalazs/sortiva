import { describe, expect, it } from 'vitest'
import { rules } from '@sortiva/rules'
import { buildDraftRequest } from '../../generation/draft'
import { lengthTargetFor } from '../../generation/length'
import { buildJudgeRequest, evaluateFloors, JUDGE_CRITERIA } from './judge'
import { buildRepairRequest } from './repair'
import { fixturePack, fixturePlan, passingDraft } from './testing'

/**
 * The two properties that make the judge a check rather than a rubber stamp:
 * it cannot see the writer's conversation, and it cannot be run on a cheaper
 * model. Both are asserted against the built request, not against a comment.
 */

const config = rules().defaults
const pack = fixturePack()
const plan = fixturePlan(pack)
const draft = passingDraft(plan)

const WRITER_PROMPT = { version: 'draft.v1', text: 'You write one ecommerce article from a closed set of approved claims.' }
const JUDGE_PROMPT = { version: 'judge.v1', text: 'You grade one finished ecommerce article.' }

const draftInput = {
  prompt: WRITER_PROMPT,
  accountId: 'a1',
  targetKeyword: 'hiking backpacks',
  shape: 'buying_guide' as const,
  axes: ['capacity'],
  claims: plan.claims,
  citableProducts: [],
  length: lengthTargetFor(pack.serp, config.generation.length),
  internalLinks: [],
}

const judgeRequest = buildJudgeRequest({
  prompt: JUDGE_PROMPT,
  accountId: 'a1',
  targetKeyword: 'hiking backpacks',
  draft,
  pack,
})

describe('the judge is blind to the writer', () => {
  const judgeText = [judgeRequest.system ?? '', ...judgeRequest.messages.map((m) => m.content)].join('\n')
  const writerRequest = buildDraftRequest(draftInput)
  const writerText = [writerRequest.system ?? '', ...writerRequest.messages.map((m) => m.content)].join('\n')

  it('carries none of the writer conversation', () => {
    expect(writerText).toContain('Approved claims')
    expect(judgeText).not.toContain('Approved claims')
    expect(judgeText).not.toContain(WRITER_PROMPT.text)
    expect(judgeText).not.toContain('Target length')
    expect(judgeText).not.toContain('Must link to')
    // The writer's claim list is formatted with its kind and confidence band;
    // none of that vocabulary may reach the grader.
    expect(judgeText).not.toMatch(/\[merchant_fact, high confidence\]/)
    expect(judgeText).not.toContain('confidence]')
  })

  it('carries none of the writer conversation after a repair either', () => {
    const repair = buildRepairRequest({
      draftInput,
      revisePrompt: { version: 'revise.v1', text: 'You are revising an article you already wrote.' },
      previousDraft: draft,
      instructions: 'Fix actionability.',
    })
    const repairText = repair.messages.map((m) => m.content).join('\n')
    expect(repairText).toContain('Fix actionability.')
    // The repair is the writer's own conversation. What matters is that the
    // judge's request is rebuilt from scratch each time and never inherits it.
    expect(judgeText).not.toContain('Fix actionability.')
    expect(judgeText).not.toContain(JSON.stringify(draft))
  })

  it('shows the article, the store facts and the ranking pages, and nothing else', () => {
    expect(judgeText).toContain('Choosing a hiking pack')
    expect(judgeText).toContain('ripstop nylon')
    expect(judgeText).toContain('rival.example')
    // Citation markers are our bookkeeping — the judge grades what a reader sees.
    expect(judgeText).not.toMatch(/\[\[[a-z0-9]+\]\]/i)
  })
})

describe('the judge is never the cheaper model', () => {
  it('names no model, so the call runs on the tier configured for judging', () => {
    expect(judgeRequest.model).toBeUndefined()
    expect(judgeRequest.callType).toBe('judge')
  })
})

describe('evaluateFloors — the minimum, never the average', () => {
  const floors = config.gates.draft_grading

  it('fails a 5/5/5/1/5 draft even though its average is 4.2', () => {
    const scores = {
      informationGain: 5,
      factualGrounding: 5,
      searchIntentMatch: 5,
      actionability: 1,
      languageQuality: 5,
    }
    const average = Object.values(scores).reduce((a, b) => a + b, 0) / Object.values(scores).length
    expect(average).toBeGreaterThan(floors.other_criteria_min)

    const evaluation = evaluateFloors(scores, floors)
    expect(evaluation.passed).toBe(false)
    expect(evaluation.failed.map((f) => f.criterion)).toEqual(['actionability'])
  })

  it('holds information gain and grounding one point higher than the rest', () => {
    const evaluation = evaluateFloors(
      {
        informationGain: 3,
        factualGrounding: 3,
        searchIntentMatch: 3,
        actionability: 3,
        languageQuality: 3,
        ecommerceUsefulness: 3,
      },
      floors,
    )
    expect(evaluation.failed.map((f) => f.criterion).sort()).toEqual(['factualGrounding', 'informationGain'])
    expect(evaluation.informationGainFailed).toBe(true)
  })

  it('passes a draft sitting exactly on every floor', () => {
    const evaluation = evaluateFloors(
      {
        informationGain: 4,
        factualGrounding: 4,
        searchIntentMatch: 3,
        actionability: 3,
        languageQuality: 3,
        ecommerceUsefulness: 3,
      },
      floors,
    )
    expect(evaluation.passed).toBe(true)
  })

  it('grades ecommerce usefulness alongside the five criteria of the quality bar', () => {
    expect([...JUDGE_CRITERIA]).toContain('ecommerceUsefulness')
    const schema = judgeRequest.schema as {
      properties: { scores: { required: string[] } }
    }
    expect(schema.properties.scores.required).toContain('ecommerceUsefulness')
  })
})
