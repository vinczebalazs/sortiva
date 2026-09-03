import { describe, expect, it } from 'vitest'
import { buildDraftRequest, writeDraft, type BuildDraftRequestInput } from './draft'
import { StubLlmClient } from './testing/stub-llm-client'

const PROMPT = { version: 'draft.v1', text: 'write the article' }

function input(overrides: Partial<BuildDraftRequestInput> = {}): BuildDraftRequestInput {
  return {
    prompt: PROMPT,
    accountId: 'a1',
    targetKeyword: 'trail shoes',
    shape: 'buying_guide',
    axes: ['terrain'],
    claims: [
      { id: 'c1', text: 'The Trailblazer is made of leather.', kind: 'merchant_fact', confidence: 'high', evidence: [] },
    ],
    citableProducts: [{ id: 'p1', productId: 'prod-1', title: 'Trailblazer' }],
    length: { minWords: 700, maxWords: 1300, source: 'serp' },
    internalLinks: [{ url: '/collections/trail', reason: 'existing_target_weak_match' }],
    ...overrides,
  }
}

describe('buildDraftRequest', () => {
  it('is stamped with call_type draft', () => {
    expect(buildDraftRequest(input()).callType).toBe('draft')
  })

  it('carries every approved claim, by id and text', () => {
    const request = buildDraftRequest(input())
    const content = request.messages.map((m) => m.content).join('\n')
    expect(content).toContain('c1')
    expect(content).toContain('The Trailblazer is made of leather.')
  })

  it('never carries a fact that is not in the approved claim list — the writer sees the plan, not the pack', () => {
    // A fact sheet value ("waterproof to 10m") that was never turned into an
    // approved claim must not leak into the writer's prompt through any other
    // channel — the whole point of the claim-plan boundary.
    const request = buildDraftRequest(input())
    const content = request.messages.map((m) => m.content).join('\n')
    expect(content).not.toContain('waterproof to 10m')
    // Nor does it carry raw SERP competitor excerpt text that was not itself
    // accepted as an external-fact claim.
    expect(content).not.toContain('Independent lab testing found the Vibram outsole')
  })

  it('carries the section order for the chosen shape, with axes expanded', () => {
    const request = buildDraftRequest(input())
    const content = request.messages.map((m) => m.content).join('\n')
    expect(content).toContain('Selection criteria: by terrain')
  })
})

describe('writeDraft', () => {
  it('parses the model output into a structured Draft', async () => {
    const llm = new StubLlmClient({
      title: 'Best trail shoes for wet terrain',
      metaDescription: 'A guide to picking trail shoes.',
      intro: 'For wet terrain, the Trailblazer is the safer choice.',
      sections: [{ heading: 'Selection criteria: by terrain', body: 'It is made of leather[[c1]].' }],
      faq: [],
      productMentions: [{ id: 'p1', productId: 'prod-1', refType: 'recommendation', fields: ['price'] }],
    })

    const result = await writeDraft({ llm }, input())
    expect(result.draft.title).toBe('Best trail shoes for wet terrain')
    expect(result.draft.sections[0]!.body).toContain('[[c1]]')
    expect(result.modelId).toBe('claude-sonnet-5')
  })
})
