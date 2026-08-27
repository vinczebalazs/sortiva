/**
 * main §14.3.5 — every step failure is one of two classes, and the class, not
 * the exception's shape, decides what happens next.
 *
 * `failed_retryable`: timeouts, 429s, 5xx, LLM `failed_validation` after its own
 * single in-call retry (§14.2). Max 3 step-level retries on the §14.3.5 schedule.
 *
 * `failed_terminal`: schema-invalid input, revoked token, 4xx that retrying
 * cannot fix. No retries. Token errors route to `awaiting_shopify_auth` (§6.2);
 * everything else to the DLQ.
 *
 * An error that is neither is treated as retryable — the safe default under a
 * queue that is already at-least-once.
 */

export abstract class StepFailure extends Error {
  abstract readonly retryable: boolean

  constructor(
    /** A short, stable slug. Ends up on the DLQ row and on `dlq_entry_created` (main §14.7). */
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
 * main §14.3.5 / §6.2 — a revoked or invalid token is terminal for the step and
 * moves the account to `awaiting_shopify_auth` rather than to the DLQ. Modelled
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

export function classify(error: unknown): {
  retryable: boolean
  errorClass: string
  message: string
} {
  if (error instanceof StepFailure) {
    return { retryable: error.retryable, errorClass: error.errorClass, message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { retryable: true, errorClass: 'unclassified', message }
}
