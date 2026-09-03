import { describe, expect, it } from 'vitest'
import type { LlmClient, LlmRequest, LlmResult } from '../contracts/llm'
import { classifyManualTopic, type FamilyChoice, type TopicClassifyPrompt } from './classify'

/**
 * A local `LlmClient` double, on the same reasoning `distill.test.ts` states:
 * `packages/llm` depends on `packages/core`, so importing `MockLlmClient` here
 * would be a cycle.
 */
class StubLlmClient implements LlmClient {
  readonly requests: LlmRequest[] = []
  constructor(private readonly answer: unknown | (() => unknown)) {}

  async complete<T>(request: LlmRequest): Promise<LlmResult<T>> {
    this.requests.push(request)
    const output = typeof this.answer === 'function' ? (this.answer as () => unknown)() : this.answer
    return {
      output: output as T,
      text: JSON.stringify(output),
      modelId: 'claude-haiku-4-5',
      promptVersion: request.promptVersion,
      cacheHit: false,
      usage: { inputTokens: 80, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      usdCost: 0.0002,
      latencyMs: 10,
      attempts: 1,
    }
  }
}

class FailingLlmClient implements LlmClient {
  async complete<T>(): Promise<LlmResult<T>> {
    throw new Error('vendor unreachable')
  }
}

const PROMPT: TopicClassifyPrompt = { version: 'topic-classify.v1', text: 'classify the topic' }

const FAMILIES: readonly FamilyChoice[] = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Trail running shoes' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Hiking boots' },
]

describe('classifyManualTopic', () => {
  it('turns a title into a cluster, carrying model id and prompt version', async () => {
    const llm = new StubLlmClient({
      head: 'best trail running shoes',
      members: ['trail running shoes for wide feet'],
      intentClass: 'buying_guide',
      familyIds: [FAMILIES[0]!.id],
    })

    const result = await classifyManualTopic(
      { llm, prompt: PROMPT },
      { accountId: 'acc-1', title: 'Best trail running shoes for wide feet', families: FAMILIES },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.cluster).toEqual({
      head: 'best trail running shoes',
      members: ['trail running shoes for wide feet'],
      intentClass: 'buying_guide',
      familyIds: [FAMILIES[0]!.id],
    })
    expect(result.modelId).toBe('claude-haiku-4-5')
    expect(result.promptVersion).toBe('topic-classify.v1')
    expect(llm.requests[0]?.callType).toBe('topic_classify')
  })

  it('drops a family id the model returned that this account does not have', async () => {
    const llm = new StubLlmClient({
      head: 'best trail running shoes',
      members: [],
      intentClass: 'buying_guide',
      familyIds: [FAMILIES[0]!.id, 'not-a-real-family-id'],
    })

    const result = await classifyManualTopic(
      { llm, prompt: PROMPT },
      { accountId: 'acc-1', title: 'Best trail running shoes', families: FAMILIES },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.cluster.familyIds).toEqual([FAMILIES[0]!.id])
  })

  it('classifies to no family at all when nothing this store sells matches', async () => {
    const llm = new StubLlmClient({
      head: 'how to fix a flat bike tire',
      members: [],
      intentClass: 'how_to',
      familyIds: [],
    })

    const result = await classifyManualTopic(
      { llm, prompt: PROMPT },
      { accountId: 'acc-1', title: 'How to fix a flat bike tire', families: FAMILIES },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.cluster.familyIds).toEqual([])
  })

  it('fails rather than guesses when the model call itself fails', async () => {
    const result = await classifyManualTopic(
      { llm: new FailingLlmClient(), prompt: PROMPT },
      { accountId: 'acc-1', title: 'Best trail running shoes', families: FAMILIES },
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.reason).toContain('vendor unreachable')
  })

  it('fails rather than guesses when the model returns an empty head term', async () => {
    const llm = new StubLlmClient({ head: '   ', members: [], intentClass: 'informational', familyIds: [] })

    const result = await classifyManualTopic(
      { llm, prompt: PROMPT },
      { accountId: 'acc-1', title: 'Best trail running shoes', families: FAMILIES },
    )

    expect(result.ok).toBe(false)
  })
})
