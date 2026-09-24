/**
 * Every step failure is one of two classes, and the class — not the exception's
 * shape — decides what happens next.
 *
 * `failed_retryable`: timeouts, 429s, 5xx, and an LLM completion that failed
 * validation after its own single in-call retry. Three step-level retries on a
 * backoff, then the dead-letter queue.
 *
 * `failed_terminal`: schema-invalid input, a revoked token, a 4xx that retrying
 * cannot fix. No retries. A dead token routes to `awaiting_shopify_auth`,
 * because it needs the merchant rather than another attempt; everything else
 * goes to the dead-letter queue.
 *
 * An error that is neither is treated as retryable — the safe default under a
 * queue that is already at-least-once.
 */

export abstract class StepFailure extends Error {
  abstract readonly retryable: boolean

  constructor(
    /** A short, stable slug. Ends up on the dead-letter row and on the alert built over it. */
    readonly errorClass: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions)
    this.name = new.target.name
  }
}

export class RetryableFailure extends StepFailure {
  readonly retryable = true
}

export class TerminalFailure extends StepFailure {
  readonly retryable = false
}

/**
 * A revoked or invalid token is terminal for the step and moves the account to
 * `awaiting_shopify_auth` rather than to the dead-letter queue — retrying
 * cannot fix it and an operator cannot either, only the merchant can. Modelled
 * as its own class so the executor can route it without string-matching.
 */
export class TokenInvalidFailure extends TerminalFailure {
  constructor(
    readonly provider: 'shopify' | 'gsc',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${provider}_token_invalid`, message, options)
  }
}

/**
 * A worker whose guard matched no rows stops immediately: someone else owns the
 * step.
 *
 * Raised when a guarded write inside a running step finds no row: the step was
 * reclaimed (its lease expired, see `lease.ts`) and another worker owns it now.
 * Not a step failure — the work is somebody else's problem, and this worker must
 * stop rather than dead-letter a step that is progressing fine elsewhere. The
 * executor turns it into `not_claimed`.
 */
export class StepOwnershipLost extends Error {
  readonly retryable = false
  readonly errorClass = 'ownership_lost'

  constructor(readonly stepId: string) {
    super(`step ${stepId} is no longer owned by this worker; stopping`)
    this.name = 'StepOwnershipLost'
  }
}

/**
 * Provider wrappers raise their own already-classified failures
 * (`LlmValidationFailure`, `LlmRequestFailure`, `SeoRequestFailure`,
 * `EmailSendFailure`) and cannot extend `StepFailure` — `packages/core` and the
 * provider packages must not depend on the job runtime. They carry the same two
 * fields instead, and are recognised structurally, so a schema-validation
 * failure reaches the DLQ as `failed_validation` rather than `unclassified`.
 */
function isClassifiedFailure(
  error: unknown,
): error is Error & { retryable: boolean; errorClass: string; message: string } {
  return (
    error instanceof Error &&
    typeof (error as { retryable?: unknown }).retryable === 'boolean' &&
    typeof (error as { errorClass?: unknown }).errorClass === 'string'
  )
}

export function classify(error: unknown): {
  retryable: boolean
  errorClass: string
  message: string
} {
  if (error instanceof StepFailure || isClassifiedFailure(error)) {
    return {
      retryable: error.retryable,
      errorClass: error.errorClass,
      message: withCause(error),
    }
  }
  const message = error instanceof Error ? withCause(error) : String(error)
  return { retryable: true, errorClass: 'unclassified', message }
}

/**
 * A wrapper's own sentence, plus the sentence of whatever actually went wrong.
 *
 * Every step that wraps a lower-level error explains what it was trying to do —
 * "could not read acme.com to work out what it runs on" — and the cause says
 * *why*, which is the half an operator needs: a refused connection, a redirect
 * loop and a response that blew the size budget all reached the dead-letter row
 * as the same sentence, and were then indistinguishable.
 *
 * One level only. A chain of five wrappers would produce a line nobody reads,
 * and the stack is recorded beside this for anyone who needs the rest.
 */
function withCause(error: Error): string {
  const cause = (error as { cause?: unknown }).cause
  if (!(cause instanceof Error) || !cause.message) return error.message
  if (error.message.includes(cause.message)) return error.message
  return `${error.message} (${cause.message})`
}
