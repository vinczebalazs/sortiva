import {
  LlmValidationFailure,
  NullRequestCache,
  recordSpend,
  type CostLedger,
  type LlmClient,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
  type PosthogCapture,
  type RequestCache,
} from '@sortiva/core'
import { llmCacheKey } from './key'
import { CALL_TYPE_TIER, MODELS, estimateTokens, overrideModel, usdCost } from './models'
import { validateCompletion } from './validate'

/**
 * The test double for `LlmClient`. It is not a stub that returns
 * a constant: it enforces the same schema contract as the real client and
 * **accounts cost**, so a test can assert what a pipeline would have spent and
 * a chaos run can assert that a resumed job did not pay twice.
 *
 * A double that models a different cost curve than production misleads any
 * spend estimate built on it. Three divergences are closed here:
 *
 * - it takes the same `RequestCache` the live client does, so a replay is free
 *   in a test exactly as it is in production;
 * - it takes the same analytics capture and spend ledger, so a pipeline test
 *   sees the two records production writes;
 * - it performs the same single repair attempt, so `attempts` means the
 *   same thing on both sides.
 *
 * Token counts are estimated from text length (≈4 characters per token) — the
 * absolute figure is not the point; that repeated work shows up as repeated
 * spend is.
 */

export interface RecordedLlmCall {
  readonly callType: string
  readonly promptVersion: string
  readonly modelId: string
  readonly usdCost: number
  readonly cacheHit: boolean
  readonly attempts: number
}

export interface MockLlmClientOptions {
  /**
   * Defaults to `NullRequestCache`, matching the live client. Inject an
   * `InMemoryRequestCache` to model a step that crashes and retries.
   */
  cache?: RequestCache
  capture?: Pick<PosthogCapture, 'captureAiGeneration'>
  ledger?: CostLedger
  now?: () => number
}

type Responder = string | ((request: LlmRequest) => string)

interface MockModelCall {
  text: string
  usage: LlmUsage
  cacheHit: boolean
  usdCost: number
}

export class MockLlmClient implements LlmClient {
  private readonly queued = new Map<string, Responder[]>()
  private readonly defaults = new Map<string, Responder>()
  private readonly cache: RequestCache
  private readonly capture: Pick<PosthogCapture, 'captureAiGeneration'> | undefined
  private readonly ledger: CostLedger | undefined
  private readonly now: () => number

  /** Every model call that reached the client, in order — replays included. */
  readonly calls: RecordedLlmCall[] = []
  /** What the pipeline would have spent, in USD. A replay adds nothing. */
  totalUsdCost = 0

  constructor(options: MockLlmClientOptions = {}) {
    this.cache = options.cache ?? new NullRequestCache()
    this.capture = options.capture
    this.ledger = options.ledger
    this.now = options.now ?? (() => Date.now())
  }

  /** Next call of this type answers with `response`; queued answers are consumed in order. */
  enqueue(callType: string, response: Responder): this {
    const list = this.queued.get(callType) ?? []
    list.push(response)
    this.queued.set(callType, list)
    return this
  }

  /** Answer for every call of this type once the queue is empty. */
  setDefault(callType: string, response: Responder): this {
    this.defaults.set(callType, response)
    return this
  }

  reset(): void {
    this.queued.clear()
    this.defaults.clear()
    this.calls.length = 0
    this.totalUsdCost = 0
  }

  get callCount(): number {
    return this.calls.length
  }

  countOf(callType: string): number {
    return this.calls.filter((c) => c.callType === callType).length
  }

  async complete<T = unknown>(request: LlmRequest): Promise<LlmResult<T>> {
    const modelId = this.modelFor(request).id
    const first = await this.callOnce(request, modelId, [...request.messages])

    const validated = validateCompletion(first.text, request.schema)
    if (validated.ok) return this.finish<T>(request, modelId, [first], validated.value, 1)

    // Retry **once** with the validation error appended, exactly as
    // the live client does, so `attempts` means the same thing in both.
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
    const second = await this.callOnce(request, modelId, repairMessages)

    const revalidated = validateCompletion(second.text, request.schema)
    if (revalidated.ok) {
      return this.finish<T>(request, modelId, [first, second], revalidated.value, 2)
    }

    throw new LlmValidationFailure(
      request.callType,
      request.promptVersion,
      modelId,
      revalidated.errors,
    )
  }

  private modelFor(request: LlmRequest) {
    const spec = MODELS[CALL_TYPE_TIER[request.callType]]
    if (request.model === undefined || request.model === spec.id) return spec
    if (request.callType === 'judge') {
      throw new Error(
        `The draft judge's model cannot be overridden per call: it is fixed at "${spec.id}", and "${request.model}" was requested.`,
      )
    }
    return overrideModel(request.model)
  }

  private async callOnce(
    request: LlmRequest,
    modelId: string,
    messages: LlmRequest['messages'],
  ): Promise<MockModelCall> {
    const spec = MODELS[CALL_TYPE_TIER[request.callType]]
    const cacheKey = llmCacheKey(request.promptVersion, modelId, request.system, messages)

    const cached = await this.cache.read(cacheKey)
    if (cached) {
      const stored = cached.responseJson as { text: string; usage: LlmUsage }
      const call: MockModelCall = { ...stored, cacheHit: true, usdCost: 0 }
      await this.record(request, modelId, call)
      return call
    }

    const text = this.respond(request, messages)
    const usage: LlmUsage = {
      inputTokens: estimateTokens((request.system ?? '') + messages.map((m) => m.content).join('')),
      outputTokens: estimateTokens(text),
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    }
    await this.cache.writeBeforeProcessing({
      cacheKey,
      kind: 'llm',
      responseJson: { text, usage, modelId },
      expiresAt: new Date(this.now() + 24 * 60 * 60 * 1000),
    })

    const call: MockModelCall = {
      text,
      usage,
      cacheHit: false,
      usdCost: usdCost(spec, usage.inputTokens, usage.outputTokens),
    }
    this.totalUsdCost = round6(this.totalUsdCost + call.usdCost)
    await this.record(request, modelId, call)
    return call
  }

  private async record(request: LlmRequest, modelId: string, call: MockModelCall): Promise<void> {
    this.calls.push({
      callType: request.callType,
      promptVersion: request.promptVersion,
      modelId,
      usdCost: call.usdCost,
      cacheHit: call.cacheHit,
      attempts: 1,
    })
    this.capture?.captureAiGeneration({
      attribution: request.attribution,
      callType: request.callType,
      promptVersion: request.promptVersion,
      modelId,
      inputTokens: call.usage.inputTokens,
      outputTokens: call.usage.outputTokens,
      latencyMs: 0,
      usdCost: call.usdCost,
      cacheHit: call.cacheHit,
      properties: { outcome: 'succeeded' },
    })
    if (this.ledger) {
      await recordSpend(this.ledger, {
        attribution: request.attribution,
        vendor: 'anthropic',
        callType: request.callType,
        usdCost: call.usdCost,
        cacheHit: call.cacheHit,
        outcome: 'succeeded',
      })
    }
  }

  private finish<T>(
    request: LlmRequest,
    modelId: string,
    calls: readonly MockModelCall[],
    output: unknown,
    attempts: number,
  ): LlmResult<T> {
    const final = calls[calls.length - 1]!
    return {
      output: output as T,
      text: final.text,
      modelId,
      promptVersion: request.promptVersion,
      cacheHit: calls.every((c) => c.cacheHit),
      usage: calls.reduce(
        (total, c) => ({
          inputTokens: total.inputTokens + c.usage.inputTokens,
          outputTokens: total.outputTokens + c.usage.outputTokens,
          cacheReadInputTokens: total.cacheReadInputTokens + c.usage.cacheReadInputTokens,
          cacheCreationInputTokens:
            total.cacheCreationInputTokens + c.usage.cacheCreationInputTokens,
        }),
        { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      ),
      usdCost: round6(calls.reduce((total, c) => total + c.usdCost, 0)),
      latencyMs: 0,
      attempts,
    }
  }

  private respond(request: LlmRequest, messages: LlmRequest['messages']): string {
    const queued = this.queued.get(request.callType)
    const responder = queued?.shift() ?? this.defaults.get(request.callType)
    if (responder === undefined) {
      throw new Error(
        `MockLlmClient has no response for call_type "${request.callType}". Use enqueue() or setDefault().`,
      )
    }
    return typeof responder === 'function' ? responder({ ...request, messages }) : responder
  }
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
