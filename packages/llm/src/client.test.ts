import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InMemoryCostLedger,
  InMemoryRequestCache,
  LlmRequestFailure,
  LlmValidationFailure,
  UnrecordedSpend,
  accountAttribution,
  previewAttribution,
  type LlmRequest,
} from '@sortiva/core'
import { MockPosthogCapture, UnrecordedCapture } from '@sortiva/providers'
import { AnthropicLlmClient } from './client'
import { llmCacheKey } from './key'
import { MODELS } from './models'

/**
 * T0.5 done-when: "cache tests (crash-after-response replays without
 * re-billing; retried LLM call replays identical completion); a cached call
 * captures `usd_cost: 0` / `cache_hit: true`".
 *
 * The rule this file holds: every exit from
 * this wrapper that reached Anthropic must leave a cost record in *both* the
 * analytics capture and the spend ledger the caps read
 * (invariant 17), including the ones where the call failed.
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

/** A client whose every call rejects, so the failure paths can be walked. */
function failingAnthropic(error: unknown) {
  return {
    messages: {
      create: vi.fn(async () => {
        throw error
      }),
    },
  }
}

/**
 * A streaming call the SDK started and that then died partway. `currentMessage`
 * is the SDK's running snapshot of the message so far, including the usage the
 * vendor has already billed for.
 */
function abortedStream(partialUsage: { input_tokens: number; output_tokens: number } | undefined) {
  return {
    messages: {
      stream: vi.fn(() => ({
        currentMessage: partialUsage ? { usage: partialUsage } : undefined,
        finalMessage: async () => {
          throw new Error('stream ended without producing a Message')
        },
      })),
      create: vi.fn(async () => {
        throw new Error('the streaming branch should have been taken')
      }),
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
  let ledger: InMemoryCostLedger

  beforeEach(() => {
    capture = new MockPosthogCapture()
    ledger = new InMemoryCostLedger()
  })

  function client(options: Record<string, unknown> = {}) {
    return new AnthropicLlmClient({
      capture,
      ledger,
      cache: new InMemoryRequestCache(),
      ...options,
    } as never)
  }

  it('validates against the schema and returns the parsed output', async () => {
    const anthropic = fakeAnthropic(['{"summary":"a leather boot"}'])
    const result = await client({ anthropic: anthropic.client }).complete<{ summary: string }>(
      request(),
    )

    expect(result.output.summary).toBe('a leather boot')
    expect(result.attempts).toBe(1)
    expect(result.modelId).toBe(MODELS.haiku.id)
    expect(result.usdCost).toBeGreaterThan(0)
  })

  it('retries once with the validation error, then succeeds (main §14.2)', async () => {
    const anthropic = fakeAnthropic(['{"wrong":true}', '{"summary":"corrected"}'])
    const result = await client({ anthropic: anthropic.client }).complete<{ summary: string }>(
      request(),
    )

    expect(result.output.summary).toBe('corrected')
    expect(result.attempts).toBe(2)
    expect(anthropic.client.messages.create).toHaveBeenCalledTimes(2)
    const second = anthropic.calls[1] as { messages: { content: string }[] }
    expect(second.messages.at(-1)!.content).toContain('failed schema validation')

    // A repair loop is two calls' worth of spend, and shows as two rows.
    expect(ledger.rows).toHaveLength(2)
  })

  it('raises the typed failed_validation after the second failure, never partial output', async () => {
    const anthropic = fakeAnthropic(['{"wrong":true}', '{"still":"wrong"}'])
    await expect(client({ anthropic: anthropic.client }).complete(request())).rejects.toBeInstanceOf(
      LlmValidationFailure,
    )
    expect(anthropic.client.messages.create).toHaveBeenCalledTimes(2)
  })

  it('writes the response to the cache before processing it (invariant 20)', async () => {
    const cache = new InMemoryRequestCache()
    // A completion that fails validation proves the ordering: the write must
    // already have happened by the time processing rejects it.
    const anthropic = fakeAnthropic(['not json at all', 'still not json'])
    await expect(
      client({ anthropic: anthropic.client, cache }).complete(request()),
    ).rejects.toBeInstanceOf(LlmValidationFailure)
    expect(cache.writes).toHaveLength(2)
  })

  it('replays an identical completion after a crash, without re-billing', async () => {
    const cache = new InMemoryRequestCache()
    const anthropic = fakeAnthropic(['{"summary":"the first sampling"}'])

    // Run one: the model answers, the response is cached, then the process dies
    // before the caller stored anything downstream.
    const before = await client({ anthropic: anthropic.client, cache }).complete<{
      summary: string
    }>(request())
    expect(before.cacheHit).toBe(false)

    // Run two: a fresh client, a fresh capture and ledger — the step retried.
    const replayCapture = new MockPosthogCapture()
    const replayLedger = new InMemoryCostLedger()
    const after = await new AnthropicLlmClient({
      anthropic: anthropic.client as never,
      cache,
      capture: replayCapture,
      ledger: replayLedger,
    }).complete<{ summary: string }>(request())

    expect(after.output).toEqual(before.output)
    expect(after.cacheHit).toBe(true)
    expect(after.usdCost).toBe(0)
    // The whole point: the model was called once across both runs.
    expect(anthropic.client.messages.create).toHaveBeenCalledTimes(1)

    const [replayed] = replayCapture.of('$ai_generation')
    expect(replayed!.properties.cache_hit).toBe(true)
    expect(replayed!.properties.$ai_total_cost_usd).toBe(0)
    // The replay is recorded at zero, not omitted.
    expect(replayLedger.rows).toHaveLength(1)
    expect(replayLedger.rows[0]).toMatchObject({ usdCost: 0, cacheHit: true, outcome: 'succeeded' })
  })

  it('captures call_type, prompt_version and the domain group on every generation', async () => {
    const anthropic = fakeAnthropic(['{"summary":"x"}'])
    await client({ anthropic: anthropic.client }).complete(request())

    const [event] = capture.of('$ai_generation')
    expect(event!.properties.call_type).toBe('distill')
    expect(event!.properties.prompt_version).toBe('distill.v1')
    expect(event!.properties.cache_hit).toBe(false)
    expect(event!.groups).toEqual({ domain: 'example.com' })

    expect(ledger.rows[0]).toMatchObject({
      vendor: 'anthropic',
      callType: 'distill',
      cacheHit: false,
      outcome: 'succeeded',
    })
    expect(ledger.rows[0]!.usdCost).toBeGreaterThan(0)
  })

  it('gives preview calls a target_domain property and no domain group (main §14.7)', async () => {
    const anthropic = fakeAnthropic(['a plain sentence'])
    await client({ anthropic: anthropic.client }).complete(
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
    // The ledger carries the same union, so `spend_events` files this under
    // `preview_target` and never under an account.
    expect(ledger.rows[0]!.attribution).toEqual({
      kind: 'preview',
      targetDomain: 'nike.com',
      billableDomain: 'nike.com',
    })
  })

  describe('the model is shown the shape it must answer in (remediation eval card 1)', () => {
    it('sends the schema to the model, whatever the prompt does or does not print', async () => {
      const anthropic = fakeAnthropic(['{"summary":"a leather boot"}'])
      await client({ anthropic: anthropic.client }).complete(
        request({ system: 'You extract product facts.' }),
      )

      const sent = anthropic.calls[0] as { system: string }
      expect(sent.system).toContain('You extract product facts.')
      // The property name the judge used to have to guess.
      expect(sent.system).toContain('"summary"')
      expect(sent.system).toContain('required')
    })

    it('still sends it when the prompt has no system text of its own', async () => {
      const anthropic = fakeAnthropic(['{"summary":"a leather boot"}'])
      await client({ anthropic: anthropic.client }).complete(request())

      const sent = anthropic.calls[0] as { system?: string }
      expect(sent.system).toContain('"summary"')
    })

    it('sends no schema block when the call has no schema to satisfy', async () => {
      const anthropic = fakeAnthropic(['free prose'])
      await client({ anthropic: anthropic.client }).complete(
        request({ schema: undefined, system: 'Be terse.' }),
      )

      const sent = anthropic.calls[0] as { system: string }
      expect(sent.system).toBe('Be terse.')
    })

    it('cannot replay an answer cached before the schema was part of the question', async () => {
      const cache = new InMemoryRequestCache()
      const stale = llmCacheKey('distill.v1', MODELS.haiku.id, 'You extract product facts.', [
        { role: 'user', content: 'Describe this product.' },
      ])
      await cache.writeBeforeProcessing({
        cacheKey: stale,
        kind: 'llm',
        responseJson: {
          text: '{"summary":"answered before the change"}',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          modelId: MODELS.haiku.id,
        },
        expiresAt: new Date(Date.now() + 60_000),
      })

      const anthropic = fakeAnthropic(['{"summary":"answered after it"}'])
      const result = await client({ anthropic: anthropic.client, cache }).complete<{
        summary: string
      }>(request({ system: 'You extract product facts.' }))

      expect(result.output.summary).toBe('answered after it')
      expect(result.cacheHit).toBe(false)
    })
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

  describe('every path that reached the vendor records a cost (remediation D2)', () => {
    it('records a vendor error as failed spend, priced on the tokens it was sent', async () => {
      const anthropic = failingAnthropic(new Error('500 internal server error'))
      await expect(client({ anthropic }).complete(request())).rejects.toBeInstanceOf(
        LlmRequestFailure,
      )

      expect(ledger.rows).toHaveLength(1)
      expect(ledger.rows[0]).toMatchObject({
        vendor: 'anthropic',
        callType: 'distill',
        cacheHit: false,
        outcome: 'failed',
      })
      expect(ledger.rows[0]!.usdCost).toBeGreaterThan(0)

      const [event] = capture.of('$ai_generation')
      expect(event!.properties).toMatchObject({ outcome: 'failed', cost_estimated: true })
    })

    it('records a dropped connection or timeout as failed spend', async () => {
      const anthropic = failingAnthropic(new Error('ETIMEDOUT'))
      await expect(client({ anthropic }).complete(request())).rejects.toMatchObject({
        errorClass: 'llm_unclassified',
        retryable: true,
      })
      expect(ledger.withOutcome('failed')).toHaveLength(1)
    })

    it('records the tokens a stream generated before it was cut off (finding 3)', async () => {
      const anthropic = abortedStream({ input_tokens: 900, output_tokens: 4_000 })
      // Above the streaming threshold, so the streaming branch is taken.
      await expect(
        client({ anthropic }).complete(request({ maxTokens: 16_000 })),
      ).rejects.toBeInstanceOf(LlmRequestFailure)

      expect(anthropic.messages.stream).toHaveBeenCalledTimes(1)
      expect(ledger.rows).toHaveLength(1)
      expect(ledger.rows[0]!.outcome).toBe('failed')
      // 900 input + 4000 output tokens at Haiku's $1 / $5 per million.
      expect(ledger.rows[0]!.usdCost).toBeCloseTo(900 / 1e6 + (4_000 * 5) / 1e6, 9)
      // Real vendor figures, not an estimate.
      expect(capture.of('$ai_generation')[0]!.properties.cost_estimated).toBe(false)
    })

    it('falls back to an estimate when a stream died before any usage arrived', async () => {
      const anthropic = abortedStream(undefined)
      await expect(
        client({ anthropic }).complete(request({ maxTokens: 16_000 })),
      ).rejects.toBeInstanceOf(LlmRequestFailure)

      expect(ledger.rows[0]!.usdCost).toBeGreaterThan(0)
      expect(capture.of('$ai_generation')[0]!.properties.cost_estimated).toBe(true)
    })

    it('records the cost when our own cache write fails after a good answer (finding 5)', async () => {
      const cache = new InMemoryRequestCache()
      cache.writeBeforeProcessing = async () => {
        throw new Error('database unavailable')
      }
      const anthropic = fakeAnthropic(['{"summary":"paid for and lost"}'])

      await expect(
        client({ anthropic: anthropic.client, cache }).complete(request()),
      ).rejects.toThrow(/database unavailable/)

      expect(ledger.rows).toHaveLength(1)
      expect(ledger.rows[0]!.outcome).toBe('succeeded')
      expect(ledger.rows[0]!.usdCost).toBeGreaterThan(0)
    })

    it('records nothing when the call never reached the vendor', async () => {
      // An unknown model id is rejected before any request is built.
      const anthropic = fakeAnthropic(['{"summary":"never sent"}'])
      await expect(
        client({ anthropic: anthropic.client }).complete(request({ model: 'claude-imaginary-9' })),
      ).rejects.toThrow(/not in the model registry/)

      expect(anthropic.client.messages.create).not.toHaveBeenCalled()
      expect(ledger.rows).toHaveLength(0)
      expect(capture.events).toHaveLength(0)
    })

    it('does not let a ledger outage mask the vendor error or lose the answer', async () => {
      ledger.failWith = new Error('spend_events unreachable')

      const ok = fakeAnthropic(['{"summary":"still delivered"}'])
      const result = await client({ anthropic: ok.client }).complete<{ summary: string }>(request())
      expect(result.output.summary).toBe('still delivered')

      await expect(
        client({ anthropic: failingAnthropic(new Error('boom')) }).complete(request()),
      ).rejects.toBeInstanceOf(LlmRequestFailure)
    })
  })

  describe('the per-call model override (finding 8)', () => {
    it('prices the overriding model, not the tier it replaced', async () => {
      const anthropic = fakeAnthropic(['{"summary":"x"}'])
      // distill is a Haiku call type; Sonnet costs twice as much per token.
      const result = await client({ anthropic: anthropic.client }).complete(
        request({ model: MODELS.sonnet.id }),
      )

      expect(result.modelId).toBe(MODELS.sonnet.id)
      expect(result.usdCost).toBeCloseTo((100 * 2) / 1e6 + (50 * 10) / 1e6, 9)
      expect(ledger.rows[0]!.usdCost).toBeCloseTo(result.usdCost, 9)
    })

    it('rejects a moving alias, as the environment override already did (§14.2)', async () => {
      const anthropic = fakeAnthropic(['{"summary":"x"}'])
      await expect(
        client({ anthropic: anthropic.client }).complete(request({ model: 'claude-sonnet-latest' })),
      ).rejects.toThrow(/moving alias/)
    })

    it('refuses to override the judge at all (invariant 11)', async () => {
      const anthropic = fakeAnthropic(['{"summary":"x"}'])
      await expect(
        client({ anthropic: anthropic.client }).complete(
          request({ callType: 'judge', promptVersion: 'judge.v2', model: MODELS.haiku.id }),
        ),
      ).rejects.toThrow(/judge's model cannot be overridden/)
    })
  })

  /**
   * The other way the judge could have been downgraded, and the reason it is
   * tested by *doing* it rather than by reading the resolver: an operator who
   * sets this variable is not calling a function, they are starting the
   * process, and what matters is the model id that leaves for Anthropic and
   * the price the spend ledger records against it.
   */
  describe('the environment model override', () => {
    /** What an operator would set to point the strong tier at the cheap model. */
    const DOWNGRADE = { ANTHROPIC_MODEL_SONNET: MODELS.haiku.id }

    it('does not move the judge, and does not make the judge cheaper on paper either', async () => {
      const anthropic = fakeAnthropic(['{"summary":"graded"}'])
      const result = await client({ anthropic: anthropic.client, env: DOWNGRADE }).complete(
        request({ callType: 'judge', promptVersion: 'judge.v2' }),
      )

      expect(result.modelId).toBe(MODELS.sonnet.id)
      expect((anthropic.calls[0] as { model: string }).model).toBe(MODELS.sonnet.id)
      // Sonnet's own rates on Sonnet's own tokens: the ledger and the model
      // agree, which is what would have come apart had the id moved and the
      // price list stayed.
      expect(ledger.rows[0]!.usdCost).toBeCloseTo((100 * 2) / 1e6 + (50 * 10) / 1e6, 9)
    })

    it('still pins every other call type on the same tier', async () => {
      const anthropic = fakeAnthropic(['{"summary":"written"}'])
      const result = await client({ anthropic: anthropic.client, env: DOWNGRADE }).complete(
        request({ callType: 'draft', promptVersion: 'draft.v2' }),
      )

      expect(result.modelId).toBe(MODELS.haiku.id)
      expect((anthropic.calls[0] as { model: string }).model).toBe(MODELS.haiku.id)
    })

    it('leaves the cheaper tier variable working', async () => {
      const anthropic = fakeAnthropic(['{"summary":"distilled"}'])
      const result = await client({
        anthropic: anthropic.client,
        env: { ANTHROPIC_MODEL_HAIKU: 'claude-haiku-4-4' },
      }).complete(request())

      expect(result.modelId).toBe('claude-haiku-4-4')
    })
  })

  it('lets a caller opt out of recording only by naming it (finding 6)', async () => {
    const anthropic = fakeAnthropic(['{"summary":"unmetered on purpose"}'])
    const silent = new AnthropicLlmClient({
      anthropic: anthropic.client as never,
      capture: new UnrecordedCapture(),
      ledger: new UnrecordedSpend(),
    })

    await expect(silent.complete(request())).resolves.toBeTruthy()
    expect(ledger.rows).toHaveLength(0)
    expect(capture.events).toHaveLength(0)
  })
})
