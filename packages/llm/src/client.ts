import Anthropic from '@anthropic-ai/sdk'
import {
  LlmRequestFailure,
  LlmValidationFailure,
  NullRequestCache,
  type LlmClient,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
  type Logger,
  type PosthogCapture,
  type RequestCache,
} from '@sortiva/core'
import { recordSpend, type CostLedger, type SpendOutcome } from '@sortiva/providers/spend/index'
import { llmCacheKey } from './key'
import {
  CALL_TYPE_TIER,
  estimateTokens,
  overrideModel,
  resolveModel,
  usdCost,
  type ModelSpec,
} from './models'
import { validateCompletion } from './validate'

export { llmCacheKey }

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
 *  5. Records every model call twice: as §14.7's `$ai_generation` analytics
 *     event, and as a row in the spend ledger the §14.5 caps read (invariant
 *     17 — "PostHog displays cost, our code enforces caps"). Replays are
 *     recorded at zero cost so cached work does not inflate spend numbers.
 *
 * The rule that shapes all of it: **recording a cost is an obligation of making
 * the call, not a side effect of the call succeeding** (`docs/audits/
 * remediation.md` D2). Anthropic bills for tokens processed, not for bytes we
 * received, so a 500, a rate limit, a timeout, a dropped connection, a stream
 * cut off partway and a cache write that fails after a good answer each leave a
 * record. Only a call that never reached the vendor records nothing.
 */

/** §14.3.6 gives billable reads a 24h TTL; LLM replays exist to make a step retry free, so they follow it. */
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** Above this the SDK wants a stream, or a long completion trips the HTTP timeout. */
const STREAMING_MAX_TOKENS_THRESHOLD = 8_192

export interface AnthropicLlmClientOptions {
  /**
   * §14.7's analytics capture. **Required** — an optional recorder meant a
   * client built without one spent real money and produced no record, with no
   * error and no log line. Pass `new UnrecordedCapture()` to opt out by name
   * (audit `docs/audits/T0.5.md` finding 6).
   */
  capture: Pick<PosthogCapture, 'captureAiGeneration'>
  /**
   * The §14.5 spend meter (invariant 17). Required for the same reason. Pass
   * `new UnrecordedSpend()` to opt out by name.
   */
  ledger: CostLedger
  anthropic?: Anthropic
  cache?: RequestCache
  env?: NodeJS.ProcessEnv
  now?: () => number
  logger?: Logger
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
  private readonly capture: Pick<PosthogCapture, 'captureAiGeneration'>
  private readonly ledger: CostLedger
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly logger: Logger | undefined

  constructor(options: AnthropicLlmClientOptions) {
    this.anthropic = options.anthropic ?? new Anthropic()
    this.cache = options.cache ?? new NullRequestCache()
    this.capture = options.capture
    this.ledger = options.ledger
    this.env = options.env ?? process.env
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger
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
    if (request.model === undefined || request.model === spec.id) return spec
    // Invariant 11 / main §8.4: "the judge is never run on a smaller model".
    // A per-call override is exactly the mechanism that would permit it, so the
    // judge's model is settled by the tier map and the environment, full stop.
    if (request.callType === 'judge') {
      throw new Error(
        `The Gate 3 judge's model cannot be overridden per call (invariant 11, main §8.4): it is fixed at "${spec.id}", and "${request.model}" was requested.`,
      )
    }
    return overrideModel(request.model)
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
      await this.record(request, spec, call, 'succeeded')
      return call
    }

    const sent = await this.send(spec, request, messages)
    if (!sent.ok) {
      // The request reached Anthropic, so the tokens it processed are billed
      // whether or not the answer reached us. `sent.usage` is the stream's
      // accumulated usage where there was one, and an estimate otherwise.
      await this.record(
        request,
        spec,
        {
          text: '',
          usage: sent.usage,
          cacheHit: false,
          latencyMs: this.now() - started,
          usdCost: usdCost(spec, sent.usage.inputTokens, sent.usage.outputTokens),
        },
        'failed',
        { cost_estimated: sent.costEstimated },
      )
      throw sent.error
    }

    const text = textOf(sent.message)
    const usage: LlmUsage = {
      inputTokens: sent.message.usage.input_tokens,
      outputTokens: sent.message.usage.output_tokens,
      cacheReadInputTokens: sent.message.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: sent.message.usage.cache_creation_input_tokens ?? 0,
    }
    const call: ModelCall = {
      text,
      usage,
      cacheHit: false,
      latencyMs: this.now() - started,
      usdCost: usdCost(spec, usage.inputTokens, usage.outputTokens),
    }

    try {
      // Invariant 20: the write happens before the completion is parsed or
      // validated. A crash on the next line still replays instead of re-billing.
      await this.cache.writeBeforeProcessing({
        cacheKey,
        kind: 'llm',
        responseJson: { text, usage, modelId: spec.id } satisfies CachedCompletion,
        expiresAt: new Date(this.now() + (request.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)),
      })
      return call
    } finally {
      // In a `finally` so a database hiccup on the cache write cannot lose a
      // cost we have already paid (audit finding 5) — while still leaving the
      // cache write first, which invariant 20 requires.
      await this.record(request, spec, call, 'succeeded')
    }
  }

  /**
   * Returns rather than throws, because the caller has to record what a failed
   * call cost — and, for a stream cut off partway, the vendor's own count of
   * the tokens it generated before the connection died.
   */
  private async send(
    spec: ModelSpec,
    request: LlmRequest,
    messages: LlmRequest['messages'],
  ): Promise<
    | { ok: true; message: Anthropic.Message }
    | { ok: false; error: LlmRequestFailure; usage: LlmUsage; costEstimated: boolean }
  > {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: spec.id,
      max_tokens: request.maxTokens,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      ...(request.system ? { system: request.system } : {}),
      ...(spec.supportsTemperature && request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
    }

    if (request.maxTokens >= STREAMING_MAX_TOKENS_THRESHOLD) {
      const stream = this.anthropic.messages.stream(params)
      try {
        return { ok: true, message: await stream.finalMessage() }
      } catch (error) {
        // A stream that ends early still generated — and was billed for — the
        // tokens accumulated so far. The SDK keeps a running snapshot of the
        // message, including its usage, which is the real figure rather than an
        // estimate (audit finding 3).
        const partial = stream.currentMessage?.usage
        return {
          ok: false,
          error: classifyAnthropicError(error, request.callType),
          usage: partial
            ? {
                inputTokens: partial.input_tokens,
                outputTokens: partial.output_tokens,
                cacheReadInputTokens: partial.cache_read_input_tokens ?? 0,
                cacheCreationInputTokens: partial.cache_creation_input_tokens ?? 0,
              }
            : estimatedUsage(request, messages),
          costEstimated: partial === undefined,
        }
      }
    }

    try {
      return { ok: true, message: await this.anthropic.messages.create(params) }
    } catch (error) {
      return {
        ok: false,
        error: classifyAnthropicError(error, request.callType),
        usage: estimatedUsage(request, messages),
        costEstimated: true,
      }
    }
  }

  /**
   * §14.7 requires the analytics event; invariant 17 requires the database
   * counter the §14.5 caps read. Both, from one place, so neither can be
   * forgotten on a path the other covers.
   *
   * Invariant 26: ids, counts, costs and flags only — no prompt or completion
   * text is passed to either.
   */
  private async record(
    request: LlmRequest,
    spec: ModelSpec,
    call: ModelCall,
    outcome: SpendOutcome,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    this.capture.captureAiGeneration({
      attribution: request.attribution,
      callType: request.callType,
      promptVersion: request.promptVersion,
      modelId: spec.id,
      inputTokens: call.usage.inputTokens,
      outputTokens: call.usage.outputTokens,
      latencyMs: call.latencyMs,
      usdCost: call.usdCost,
      cacheHit: call.cacheHit,
      properties: { outcome, ...extra },
    })
    await recordSpend(
      this.ledger,
      {
        attribution: request.attribution,
        vendor: 'anthropic',
        callType: request.callType,
        usdCost: call.usdCost,
        cacheHit: call.cacheHit,
        outcome,
      },
      this.logger,
    )
  }
}

/** Input tokens for a call whose usage never came back. See `estimateTokens`. */
function estimatedUsage(request: LlmRequest, messages: LlmRequest['messages']): LlmUsage {
  return {
    inputTokens: estimateTokens((request.system ?? '') + messages.map((m) => m.content).join('')),
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
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
