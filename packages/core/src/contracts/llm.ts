import type { EventAttribution } from './analytics'

/**
 * The shape every LLM call takes. The one instrumented implementation lives in
 * `@sortiva/llm`; importing the Anthropic SDK anywhere else is a lint error, so
 * no call can escape cost tracking, caching or validation.
 */

/** Captured on every model call, and the unit spend is broken down by. */
export const LLM_CALL_TYPES = [
  'distill',
  'persona',
  'seeds',
  'judge',
  'preview',
  'intent_gap',
  'optimize_reco',
  /**
   * A merchant-typed calendar topic title → `{head, members, intentClass,
   * familyIds}`. Added by T4.2, on the founder's authorisation, once the
   * "what turns free text into a QueryCluster" gap flagged by T4.1 was
   * resolved — see DECISIONS 2026-09-03 T4.2. Runs once per manual add, never
   * across a scan, so it does not carry Gate 1's "~free" requirement.
   */
  'topic_classify',
  /**
   * T4.3's claim plan — every assertion the article will make, enumerated
   * against the evidence pack and bound to it, before any prose is written.
   * Runs once per article, over the evidence pack; its output (not the pack
   * itself) is what the `draft` call below is ever shown.
   * `docs/content-pointers.md` §1.
   */
  'claim_plan',
  /**
   * T4.3's writer: Sonnet, given only the approved claim list from
   * `claim_plan` and the section shape — never the raw evidence pack, so
   * there is no route to asserting something no claim covers.
   * `docs/content-pointers.md` §1.
   */
  'draft',
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
   * alongside `model_id`, so any output can be reproduced later.
   */
  readonly promptVersion: string
  readonly system?: string
  readonly messages: readonly LlmMessage[]
  readonly maxTokens: number
  /**
   * JSON Schema the completion must satisfy. Validated on every call; on
   * failure we retry **once** with the validation error appended, and on the
   * second failure the step enters `failed_validation`. We never salvage what
   * parsed and carry on with a half-built object.
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
  /** How many model calls this took: 1, or 2 when the validation retry fired. */
  readonly attempts: number
}

/**
 * The typed `failed_validation` state, reached only after the single in-call
 * retry. It is retryable at the job level, so it carries the shape the runtime's
 * `classify()` reads.
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
 * A transport-level failure from the model API, already classified for the job
 * runtime: 429s, 5xx and connection errors are retryable; a 4xx that retrying
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
