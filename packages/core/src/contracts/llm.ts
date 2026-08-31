import type { EventAttribution } from './analytics'

/**
 * main §14.2, §14.7 / invariant 25 — the shape every LLM call takes. The one
 * instrumented implementation lives in `@sortiva/llm`; importing the Anthropic
 * SDK anywhere else is a lint error.
 */

/** main §14.7 — `call_type` is captured on every `$ai_generation`. */
export const LLM_CALL_TYPES = [
  'distill',
  'persona',
  'seeds',
  'judge',
  'preview',
  'intent_gap',
  'optimize_reco',
] as const

export type LlmCallType = (typeof LLM_CALL_TYPES)[number]

export interface LlmMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

export interface LlmRequest {
  readonly callType: LlmCallType
  /**
   * The prompt file's version, e.g. `distill.v1`. Stamped on every artefact
   * alongside `model_id` so any output is reproducible (main §14.2).
   */
  readonly promptVersion: string
  readonly system?: string
  readonly messages: readonly LlmMessage[]
  readonly maxTokens: number
  /**
   * JSON Schema the completion must satisfy. main §14.2: validate on every
   * call; on failure retry **once** with the validation error appended; on the
   * second failure the step enters `failed_validation` — never "parse what we can".
   */
  readonly schema?: object
  readonly attribution: EventAttribution
  /** Overrides the call type's configured model. Explicit ids only, never "latest" aliases. */
  readonly model?: string
  /** Ignored on models that reject sampling parameters; see the model registry. */
  readonly temperature?: number
  /** Request-cache TTL. Defaults to the LLM class default in the wrapper. */
  readonly cacheTtlMs?: number
}

export interface LlmUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens: number
  readonly cacheCreationInputTokens: number
}

export interface LlmResult<T = unknown> {
  /** The parsed, schema-valid completion when a schema was supplied; the raw text otherwise. */
  readonly output: T
  readonly text: string
  readonly modelId: string
  readonly promptVersion: string
  /** True when this was replayed from `request_cache` — captured, and costed at zero. */
  readonly cacheHit: boolean
  readonly usage: LlmUsage
  readonly usdCost: number
  readonly latencyMs: number
  /** How many model calls this took: 1, or 2 when the §14.2 validation retry fired. */
  readonly attempts: number
}

/**
 * main §14.2 — the typed `failed_validation` state, reached only after the
 * single in-call retry. §14.3.5 classes it `failed_retryable`, so it carries the
 * shape the job runtime's `classify()` reads.
 */
export class LlmValidationFailure extends Error {
  readonly retryable = true
  readonly errorClass = 'failed_validation'

  constructor(
    readonly callType: string,
    readonly promptVersion: string,
    readonly modelId: string,
    /** Ajv messages from the final attempt. */
    readonly validationErrors: readonly string[],
  ) {
    super(
      `${callType} (${promptVersion} / ${modelId}) failed schema validation twice: ${validationErrors.join('; ')}`,
    )
    this.name = 'LlmValidationFailure'
  }
}

/**
 * A transport-level failure from the model API, already classified for main
 * §14.3.5 — 429s, 5xx and connection errors are retryable; a 4xx that retrying
 * cannot fix is terminal.
 */
export class LlmRequestFailure extends Error {
  constructor(
    readonly retryable: boolean,
    readonly errorClass: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions)
    this.name = 'LlmRequestFailure'
  }
}

export interface LlmClient {
  complete<T = unknown>(request: LlmRequest): Promise<LlmResult<T>>
}
