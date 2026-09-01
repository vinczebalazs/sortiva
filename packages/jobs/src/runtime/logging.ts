import { createLogger, type Logger } from '@sortiva/core'

/**
 * Ids and aggregates only — never product content, article text, prompts, or
 * anything customer-derived — and no token ever appears in a log line, an
 * analytics event or an error report.
 *
 * This is the runtime's handle on the structured logger `packages/core` already
 * provides: JSON lines through the secret scrubber, so a token that reaches a
 * field or a message is redacted by the same pass either way. It is deliberately
 * *not* a second logger — nothing here formats, filters or transports anything;
 * it only decides which instance the worker uses.
 *
 * The boundary against analytics: analytics answers "how often, and how is the
 * fleet doing"; these lines answer "what happened to this one store,
 * in order, with the error attached". A merchant saying "I connected four days
 * ago and nothing happened" is the second question, and until now the only trail
 * was hand-written SQL.
 *
 * **What may be logged: identifiers, states, durations, counts, error classes.**
 * Never a product title, body, prompt, draft, or anything else derived from a
 * merchant's catalogue or customers. A step handler that wants to log "what it
 * found" logs how many,
 * not which.
 */

let runtime: Logger | undefined

/** The logger every step runs under unless a caller supplies its own. */
export function runtimeLogger(): Logger {
  runtime ??= createLogger({ base: { component: 'worker' } })
  return runtime
}

/**
 * Replaces the runtime logger process-wide. The worker bootstrap may point it at
 * a different sink; tests capture the records this way rather than reading
 * stdout.
 */
export function setRuntimeLogger(logger: Logger | undefined): void {
  runtime = logger
}

/**
 * The fields every line about a step carries, so one store's whole pipeline is a
 * single filter in whatever reads the logs. Snake_case to match the analytics
 * property convention, so a log line and its event agree on field names.
 */
export interface StepLogFields {
  account_id: string
  job_id: string
  step_id: string
  step: string
  attempt: number
  idempotency_key: string
}

export function stepLogger(base: Logger, fields: StepLogFields): Logger {
  return base.child({ ...fields })
}
