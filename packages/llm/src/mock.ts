import {
  LlmValidationFailure,
  type LlmClient,
  type LlmRequest,
  type LlmResult,
} from '@sortiva/core'
import { CALL_TYPE_TIER, MODELS, usdCost } from './models'
import { validateCompletion } from './validate'

/**
 * The test double for `LlmClient` (work plan §4). It is not a stub that returns
 * a constant: it enforces the same schema contract as the real client and
 * **accounts cost**, so a test can assert what a pipeline would have spent and
 * a chaos run can assert that a resumed job did not pay twice (main §14.3.9).
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
  readonly attempts: number
}

type Responder = string | ((request: LlmRequest) => string)

export class MockLlmClient implements LlmClient {
  private readonly queued = new Map<string, Responder[]>()
  private readonly defaults = new Map<string, Responder>()

  /** Every call that reached the client, in order. */
  readonly calls: RecordedLlmCall[] = []
  /** What the pipeline would have spent, in USD. */
  totalUsdCost = 0

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
    const spec = MODELS[CALL_TYPE_TIER[request.callType]]
    const modelId = request.model ?? spec.id

    const text = this.respond(request)
    const validated = validateCompletion(text, request.schema)

    const inputTokens = estimateTokens(
      (request.system ?? '') + request.messages.map((m) => m.content).join(''),
    )
    const outputTokens = estimateTokens(text)
    const cost = usdCost(spec, inputTokens, outputTokens)
    this.totalUsdCost = round6(this.totalUsdCost + cost)
    this.calls.push({
      callType: request.callType,
      promptVersion: request.promptVersion,
      modelId,
      usdCost: cost,
      attempts: 1,
    })

    if (!validated.ok) {
      // The double enforces the same contract as the real client: a scripted
      // response that does not match the schema fails the way production would,
      // rather than sailing through and hiding a bad fixture.
      throw new LlmValidationFailure(
        request.callType,
        request.promptVersion,
        modelId,
        validated.errors,
      )
    }

    return {
      output: validated.value as T,
      text,
      modelId,
      promptVersion: request.promptVersion,
      cacheHit: false,
      usage: {
        inputTokens,
        outputTokens,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      usdCost: cost,
      latencyMs: 0,
      attempts: 1,
    }
  }

  private respond(request: LlmRequest): string {
    const queued = this.queued.get(request.callType)
    const responder = queued?.shift() ?? this.defaults.get(request.callType)
    if (responder === undefined) {
      throw new Error(
        `MockLlmClient has no response for call_type "${request.callType}". Use enqueue() or setDefault().`,
      )
    }
    return typeof responder === 'function' ? responder(request) : responder
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
