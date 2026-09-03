import { describe, expect, it } from 'vitest'
import { emptyFactSheet } from '../distill/schema'
import { buildClaimPlanRequest, planClaims } from './claim-plan'
import { assembleEvidencePack } from './evidence-pack'
import { StubLlmClient } from './testing/stub-llm-client'

const PROMPT = { version: 'claim-plan.v1', text: 'plan claims' }

function samplePack() {
  return assembleEvidencePack({
    accountId: 'a1',
    topicId: 't1',
    intentClass: 'buying_guide',
    targetKeyword: 'trail shoes',
    families: [{ familyId: 'f1', name: 'Trail shoes', differentiationAxes: ['terrain'] }],
    products: [
      {
        productId: 'p1',
        familyId: 'f1',
        title: 'Trailblazer',
        images: [],
        factSheet: { ...emptyFactSheet(), material: 'leather' },
      },
    ],
    serp: {
      keyword: 'trail shoes',
      locale: 'en-US',
      topResultCount: 1,
      averageWordCount: 900,
      competitorAngles: [
        {
          url: 'https://rival.example/guide',
          domain: 'rival.example',
          position: 2,
          headings: ['Grip on wet rock'],
          excerpt: 'Independent lab testing found the Vibram outsole gripped wet granite best.',
        },
      ],
    },
    linkTasks: [],
    now: new Date('2026-09-03T00:00:00Z'),
  })
}

describe('planClaims', () => {
  it('accepts a recommendation that names a real claim id, and an external fact quoted verbatim', async () => {
    const pack = samplePack()
    const llm = new StubLlmClient({
      claims: [
        {
          text: 'For wet terrain, the Trailblazer is the safer pick.',
          kind: 'recommendation',
          confidence: 'medium',
          evidenceRefs: ['c1'],
          quote: null,
        },
        {
          text: 'Independent testing found this outsole grips wet granite best.',
          kind: 'external_fact',
          confidence: 'high',
          evidenceRefs: [],
          quote: {
            text: 'Independent lab testing found the Vibram outsole gripped wet granite best.',
            url: 'https://rival.example/guide',
          },
        },
      ],
      gaps: [],
    })

    const result = await planClaims({ llm, prompt: PROMPT }, pack)

    expect(result.plan.claims.some((c) => c.kind === 'merchant_fact')).toBe(true)
    const recommendation = result.plan.claims.find((c) => c.kind === 'recommendation')
    expect(recommendation).toBeDefined()
    expect(recommendation!.evidence).toEqual([{ kind: 'claim', claimRef: 'c1' }])

    const external = result.plan.claims.find((c) => c.kind === 'external_fact')
    expect(external).toBeDefined()
    expect(external!.evidence[0]).toMatchObject({ kind: 'page', url: 'https://rival.example/guide' })
    expect(result.plan.gaps).toHaveLength(0)
  })

  it('drops a recommendation that names no real claim, into gaps rather than the plan', async () => {
    const pack = samplePack()
    const llm = new StubLlmClient({
      claims: [
        { text: 'Wild guess.', kind: 'recommendation', confidence: 'low', evidenceRefs: ['c999'], quote: null },
      ],
      gaps: [],
    })

    const result = await planClaims({ llm, prompt: PROMPT }, pack)
    expect(result.plan.claims.some((c) => c.kind === 'recommendation')).toBe(false)
    expect(result.plan.gaps.some((g) => g.text === 'Wild guess.')).toBe(true)
  })

  it('drops an external fact whose quote does not match the source excerpt verbatim', async () => {
    const pack = samplePack()
    const llm = new StubLlmClient({
      claims: [
        {
          text: 'Paraphrased claim.',
          kind: 'external_fact',
          confidence: 'high',
          evidenceRefs: [],
          quote: { text: 'This quote was not actually in the excerpt.', url: 'https://rival.example/guide' },
        },
      ],
      gaps: [],
    })

    const result = await planClaims({ llm, prompt: PROMPT }, pack)
    expect(result.plan.claims.some((c) => c.kind === 'external_fact')).toBe(false)
    expect(result.plan.gaps.some((g) => g.text === 'Paraphrased claim.')).toBe(true)
  })

  it('carries the model gaps through untouched', async () => {
    const pack = samplePack()
    const llm = new StubLlmClient({ claims: [], gaps: [{ text: 'Comfort rating', reason: 'no evidence at all' }] })
    const result = await planClaims({ llm, prompt: PROMPT }, pack)
    expect(result.plan.gaps).toContainEqual({ text: 'Comfort rating', reason: 'no evidence at all' })
  })
})

describe('buildClaimPlanRequest', () => {
  it('is stamped with call_type claim_plan and the given prompt version', () => {
    const pack = samplePack()
    const request = buildClaimPlanRequest({ prompt: PROMPT, pack, deterministicClaims: [] })
    expect(request.callType).toBe('claim_plan')
    expect(request.promptVersion).toBe('claim-plan.v1')
  })
})
