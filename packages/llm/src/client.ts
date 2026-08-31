import { createHash } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import {
  LlmRequestFailure,
  LlmValidationFailure,
  NullRequestCache,
  type LlmClient,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
  type PosthogCapture,
  type RequestCache,
} from '@sortiva/core'
import { CALL_TYPE_TIER, resolveModel, usdCost, type ModelSpec } from './models'
import { validateCompletion } from './validate'

/**
 * Invariant 25 / main §14.7 — the single instrumented Anthropic client. Every
 * LLM call in the product goes through `complete()`; a lint rule makes importing
 * the SDK anywhere else a build failure, so no call site can escape cost
 * tracking, caching, or schema validation.
 *
 * What one `complete()` does, in order:
 *
 *  1. Resolves the model from the call type (main §15 fixes the tier) and the
 *     explicit id registry (§14.2 — never a "latest" alias).
 *  2. Consults the request cache, keyed `(prompt_version, model_id,
 *     sha256(rendered prompt))` (§14.3.6). A hit replays the stored completion
 *     rather than re-sampling — so a retried step cannot get a *different*
 *     persona than the run it is resuming.
 *  3. On a miss, calls the model and writes the raw response to the cache
 *     **before processing it** (invariant 20), so a crash between the model
 *     answering and us finishing costs nothing on retry.
 *  4. Validates against the call's JSON Schema; on failure retries **once** with
 *     the validation error appended; on the second failure raises the typed
 *     `failed_validation` (§14.2).
 *  5. Captures `$ai_generation` per model call with `call_type`,
 *     `prompt_version` and `cache_hit`; replays are captured at zero cost so
 *     cached work does not inflate spend numbers (§14.7).
 */

/** §14.3.6 gives billable reads a 24h TTL; LLM replays exist to make a step retry free, so they follow it. */
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** Above this the SDK wants a stream, or a long completion trips the HTTP timeout. */
const STREAMING_MAX_TOKENS_THRESHOLD = 8_192

export interface AnthropicLlmClientOptions {
  anthropic?: Anthropic
  cache?: RequestCache
  capture?: Pick<PosthogCapture, 'captureAiGeneration'>
  env?: NodeJS.ProcessEnv
  now?: () => number
}

interface ModelCall {
  text: string
  usage: LlmUsage
  cacheHit: boolean
  latencyMs: number
  usdCost: number
}

interface CachedCompletion {
  text: string
  usage: LlmUsage
  modelId: string
}

export class AnthropicLlmClient implements LlmClient {
  private readonly anthropic: Anthropic
  private readonly cache: RequestCache
  private readonly capture: Pick<PosthogCapture, 'captureAiGeneration'> | undefined
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number

  constructor(options: AnthropicLlmClientOptions = {}) {
    this.anthropic = options.anthropic ?? new Anthropic()
    this.cache = options.cache ?? new NullRequestCache()
    this.capture = options.capture
    this.env = options.env ?? process.env
    this.now = options.now ?? (() => Date.now())
  }

  async complete<T = unknown>(request: LlmRequest): Promise<LlmResult<T>> {
    const spec = this.modelFor(request)
    const first = await this.callModel(request, spec, [...request.messages])

    const validated = validateCompletion(first.text, request.schema)
    if (validated.ok) {
      return this.finish<T>(request, spec, [first], first, validated.value, 1)
    }

    // main §14.2 — retry **once** with the validation error appended.
    const repairMessages: LlmRequest['messages'] = [
      ...request.messages,
      { role: 'assistant', content: first.text },
      {
        role: 'user',
        content:
          'That response failed schema validation:\n' +
          validated.errors.map((e) => `- ${e}`).join('\n') +
          '\n\nReturn the corrected response. Output JSON only, matching the schema exactly.',
      },
    ]
    const second = await this.callModel(request, spec, repairMessages)

    const revalidated = validateCompletion(second.text, request.schema)
    if (revalidated.ok) {
      return this.finish<T>(request, spec, [first, second], second, revalidated.value, 2)
    }

    throw new LlmValidationFailure(
      request.callType,
      request.promptVersion,
      spec.id,
      revalidated.errors,
    )
  }

  private modelFor(request: LlmRequest): ModelSpec {
    const tier = CALL_TYPE_TIER[request.callType]
    const spec = resolveModel(tier, this.env)
    return request.model ? { ...spec, id: request.model } : spec
  }

  private finish<T>(
    request: LlmRequest,
    spec: ModelSpec,
    calls: readonly ModelCall[],
    final: ModelCall,
    output: unknown,
    attempts: number,
  ): LlmResult<T> {
    return {
      output: output as T,
      text: final.text,
      modelId: spec.id,
      promptVersion: request.promptVersion,
      // The result is a replay only if every model call it took was one.
      cacheHit: calls.every((c) => c.cacheHit),
      usage: sumUsage(calls.map((c) => c.usage)),
      usdCost: calls.reduce((total, c) => total + c.usdCost, 0),
      latencyMs: calls.reduce((total, c) => total + c.latencyMs, 0),
      attempts,
    }
  }

  /** One model call: cache lookup, or a real request plus a write-before-processing. */
  private async callModel(
    request: LlmRequest,
    spec: ModelSpec,
    messages: LlmRequest['messages'],
  ): Promise<ModelCall> {
    const cacheKey = llmCacheKey(request.promptVersion, spec.id, request.system, messages)
    const started = this.now()

    const cached = await this.cache.read(cacheKey)
    if (cached) {
      const stored = cached.responseJson as CachedCompletion
      const call: ModelCall = {
        text: stored.text,
        usage: stored.usage,
        cacheHit: true,
        latencyMs: this.now() - started,
        // main §14.7 — "replays served from request_cache are captured with
        // cache_hit: true and **zero cost**".
        usdCost: 0,
      }
      this.emit(request, spec, call)
      return call
    }

    const message = await this.send(spec, request, messages)
    const text = textOf(message)
    const usage: LlmUsage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
    }

    // Invariant 20: the write happens before the completion is parsed or
    // validated. A crash on the next line still replays instead of re-billing.
    await this.cache.writeBeforeProcessing({
      cacheKey,
      kind: 'llm',
      responseJson: { text, usage, modelId: spec.id } satisfies CachedCompletion,
      expiresAt: new Date(this.now() + (request.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)),
    })

    const call: ModelCall = {
      text,
      usage,
      cacheHit: false,
      latencyMs: this.now() - started,
      usdCost: usdCost(spec, usage.inputTokens, usage.outputTokens),
    }
    this.emit(request, spec, call)
    return call
  }

  private async send(
    spec: ModelSpec,
    request: LlmRequest,
    messages: LlmRequest['messages'],
  ): Promise<Anthropic.Message> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: spec.id,
      max_tokens: request.maxTokens,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      ...(request.system ? { system: request.system } : {}),
      ...(spec.supportsTemperature && request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
    }

    try {
      if (request.maxTokens >= STREAMING_MAX_TOKENS_THRESHOLD) {
        return await this.anthropic.messages.stream(params).finalMessage()
      }
      return await this.anthropic.messages.create(params)
    } catch (error) {
      throw classifyAnthropicError(error, request.callType)
    }
  }

  private emit(request: LlmRequest, spec: ModelSpec, call: ModelCall): void {
    this.capture?.captureAiGeneration({
      attribution: request.attribution,
      callType: request.callType,
      promptVersion: request.promptVersion,
      modelId: spec.id,
      inputTokens: call.usage.inputTokens,
      outputTokens: call.usage.outputTokens,
      latencyMs: call.latencyMs,
      usdCost: call.usdCost,
      cacheHit: call.cacheHit,
    })
  }
}

function sumUsage(usages: readonly LlmUsage[]): LlmUsage {
  return usages.reduce(
    (total, u) => ({
      inputTokens: total.inputTokens + u.inputTokens,
      outputTokens: total.outputTokens + u.outputTokens,
      cacheReadInputTokens: total.cacheReadInputTokens + u.cacheReadInputTokens,
      cacheCreationInputTokens: total.cacheCreationInputTokens + u.cacheCreationInputTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  )
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/**
 * §14.3.6 — the cache key is `(prompt_version, model_id, sha256(rendered
 * prompt))`. The prompt is serialised canonically so message order and role are
 * part of the hash and nothing else is.
 */
export function llmCacheKey(
  promptVersion: string,
  modelId: string,
  system: string | undefined,
  messages: readonly { role: string; content: string }[],
): string {
  const rendered = JSON.stringify({ system: system ?? null, messages })
  const digest = createHash('sha256').update(rendered, 'utf8').digest('hex')
  return `llm:${promptVersion}:${modelId}:${digest}`
}

/** main §14.3.5 — 429s, 5xx and connection errors retry; a 4xx that retrying cannot fix does not. */
export function classifyAnthropicError(error: unknown, callType: string): LlmRequestFailure {
  if (error instanceof Anthropic.RateLimitError) {
    return new LlmRequestFailure(true, 'llm_rate_limited', `${callType}: rate limited`, {
      cause: error,
    })
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmRequestFailure(true, 'llm_connection', `${callType}: ${error.message}`, {
      cause: error,
    })
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0
    const retryable = status === 408 || status === 409 || status === 429 || status >= 500
    return new LlmRequestFailure(
      retryable,
      retryable ? 'llm_upstream' : 'llm_bad_request',
      `${callType}: model API returned ${status}: ${error.message}`,
      { cause: error },
    )
  }
  return new LlmRequestFailure(
    true,
    'llm_unclassified',
    `${callType}: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  )
}
