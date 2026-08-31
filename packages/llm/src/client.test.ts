import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InMemoryRequestCache,
  LlmValidationFailure,
  accountAttribution,
  previewAttribution,
  type LlmRequest,
} from '@sortiva/core'
import { MockPosthogCapture } from '@sortiva/providers'
import { AnthropicLlmClient, llmCacheKey } from './client'
import { MODELS } from './models'

/**
 * T0.5 done-when: "cache tests (crash-after-response replays without
 * re-billing; retried LLM call replays identical completion); a cached call
 * captures `usd_cost: 0` / `cache_hit: true`".
 */

const SCHEMA = {
  type: 'object',
  required: ['summary'],
  properties: { summary: { type: 'string' } },
  additionalProperties: false,
}

/** A stand-in for the Anthropic SDK's `messages` namespace, counting real calls. */
function fakeAnthropic(responses: string[]) {
  const calls: unknown[] = []
  let index = 0
  return {
    calls,
    client: {
      messages: {
        create: vi.fn(async (params: unknown) => {
          calls.push(params)
          const text = responses[Math.min(index++, responses.length - 1)] ?? '{}'
          return {
            content: [{ type: 'text', text }],
            usage: { input_tokens: 100, output_tokens: 50 },
          }
        }),
      },
    },
  }
}

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    callType: 'distill',
    promptVersion: 'distill.v1',
    messages: [{ role: 'user', content: 'Describe this product.' }],
    maxTokens: 512,
    schema: SCHEMA,
    attribution: accountAttribution('acc-1', 'example.com'),
    ...overrides,
  }
}

describe('AnthropicLlmClient', () => {
  let capture: MockPosthogCapture

  beforeEach(() => {
    capture = new MockPosthogCapture()
  })

  it('validates against the schema and returns the parsed output', async () => {
    const anthropic = fakeAnthropic(['{"summary":"a leather boot"}'])
    const client = new AnthropicLlmClient({
      anthropic: anthropic.client as never,
      cache: new InMemoryRequestCache(),
      capture,
    })

    const result = await client.complete<{ summary: string }>(request())

    expect(result.output.summary).toBe('a leather boot')
    expect(result.attempts).toBe(1)
    expect(result.modelId).toBe(MODELS.haiku.id)
    expect(result.usdCost).toBeGreaterThan(0)
  })

  it('retries once with the validation error, then succeeds (main §14.2)', async () => {
    const anthropic = fakeAnthropic(['{"wrong":true}', '{"summary":"corrected"}'])
    const client = new AnthropicLlmClient({
      anthropic: anthropic.client as never,
      cache: new InMemoryRequestCache(),
      capture,
    })

    const result = await client.complete<{ summary: string }>(request())

    expect(result.output.summary).toBe('corrected')
    expect(result.attempts).toBe(2)
    expect(anthropic.client.messages.create).toHaveBeenCalledTimes(2)
    // The repair turn carries the validation error back to the model.
    const second = anthropic.calls[1] as { messages: { content: string }[] }
    expect(second.messages.at(-1)!.content).toContain('failed schema validation')
  })

  it('raises the typed failed_validation after the second failure, never partial output', async () => {
    const anthropic = fakeAnthropic(['{"wrong":true}', '{"still":"wrong"}'])
    const client = new AnthropicLlmClient({
      anthropic: anthropic.client as never,
      cache: new InMemoryRequestCache(),
      capture,
    })

    await expect(client.complete(request())).rejects.toBeInstanceOf(LlmValidationFailure)
    expect(anthropic.client.messages.create).toHaveBeenCalledTimes(2)
  })

  it('writes the response to the cache before processing it (invariant 20)', async () => {
    const cache = new InMemoryRequestCache()
    // A completion that fails validation proves the ordering: the write must
    // already have happened by the time processing rejects it.
    const anthropic = fakeAnthropic(['not json at all', 'still not json'])
    const client = new AnthropicLlmClient({
      anthropic: anthropic.client as never,
      cache,
      capture,
    })

    await expect(client.complete(request())).rejects.toBeInstanceOf(LlmValidationFailure)
    expect(cache.writes).toHaveLength(2)
  })

  it('replays an identical completion after a crash, without re-billing', async () => {
    const cache = new InMemoryRequestCache()
    const anthropic = fakeAnthropic(['{"summary":"the first sampling"}'])

    // Run one: the model answers, the response is cached, then the process dies
    // before the caller stored anything downstream.
    const first = new AnthropicLlmClient({ anthropic: anthropic.client as never, cache, capture })
    const before = await first.complete<{ summary: string }>(request())
    expect(before.cacheHit).toBe(false)

    // Run two: a fresh client, a fresh capture — the step retried.
    const replayCapture = new MockPosthogCapture()
    const second = new AnthropicLlmClient({
      anthropic: anthropic.client as never,
      cache,
      capture: replayCapture,
    })
    const after = await second.complete<{ summary: string }>(request())

    expect(after.output).toEqual(before.output)
    expect(after.cacheHit).toBe(true)
    expect(after.usdCost).toBe(0)
    // The whole point: the model was called once across both runs.
    expect(anthropic.client.messages.create).toHaveBeenCalledTimes(1)

    const [replayed] = replayCapture.of('$ai_generation')
    expect(replayed!.properties.cache_hit).toBe(true)
    expect(replayed!.properties.$ai_total_cost_usd).toBe(0)
  })

  it('captures call_type, prompt_version and the domain group on every generation', async () => {
    const anthropic = fakeAnthropic(['{"summary":"x"}'])
    const client = new AnthropicLlmClient({
      anthropic: anthropic.client as never,
      cache: new InMemoryRequestCache(),
      capture,
    })

    await client.complete(request())

    const [event] = capture.of('$ai_generation')
    expect(event!.properties.call_type).toBe('distill')
    expect(event!.properties.prompt_version).toBe('distill.v1')
    expect(event!.properties.cache_hit).toBe(false)
    expect(event!.groups).toEqual({ domain: 'example.com' })
  })

  it('gives preview calls a target_domain property and no domain group (main §14.7)', async () => {
    const anthropic = fakeAnthropic(['a plain sentence'])
    const client = new AnthropicLlmClient({
      anthropic: anthropic.client as never,
      cache: new InMemoryRequestCache(),
      capture,
    })

    await client.complete(
      request({
        callType: 'preview',
        promptVersion: 'preview.v1',
        schema: undefined,
        attribution: previewAttribution('nike.com'),
      }),
    )

    const [event] = capture.of('$ai_generation')
    expect(event!.groups).toEqual({})
    expect(event!.properties.target_domain).toBe('nike.com')
  })

  it('keys the cache on prompt version, model and prompt hash (main §14.3.6)', () => {
    const messages = [{ role: 'user' as const, content: 'hello' }]
    const a = llmCacheKey('distill.v1', 'claude-haiku-4-5', undefined, messages)
    const b = llmCacheKey('distill.v2', 'claude-haiku-4-5', undefined, messages)
    const c = llmCacheKey('distill.v1', 'claude-sonnet-5', undefined, messages)
    const d = llmCacheKey('distill.v1', 'claude-haiku-4-5', 'be terse', messages)

    expect(new Set([a, b, c, d]).size).toBe(4)
    expect(a).toBe(llmCacheKey('distill.v1', 'claude-haiku-4-5', undefined, [...messages]))
  })
})
