/**
 * main §14.3.5 — "max 3 step-level retries, exponential backoff 1m / 5m / 25m
 * with ±20% jitter (prevents synchronized retry stampedes after a provider
 * outage)."
 */

const MINUTE_MS = 60_000

/** The schedule, in order. Index 0 is the delay before attempt 2. */
export const BACKOFF_SCHEDULE_MS: readonly number[] = [1 * MINUTE_MS, 5 * MINUTE_MS, 25 * MINUTE_MS]

export const MAX_ATTEMPTS = BACKOFF_SCHEDULE_MS.length + 1

export const JITTER_FRACTION = 0.2

/**
 * @param attempts how many attempts have already been made (1 after the first failure).
 * @returns the delay before the next attempt, or `undefined` when retries are exhausted.
 */
export function nextAttemptDelayMs(
  attempts: number,
  random: () => number = Math.random,
): number | undefined {
  const base = BACKOFF_SCHEDULE_MS[attempts - 1]
  if (base === undefined) return undefined
  // Uniform in [-20%, +20%].
  const jitter = (random() * 2 - 1) * JITTER_FRACTION
  return Math.round(base * (1 + jitter))
}

export function nextAttemptAt(
  attempts: number,
  now: Date = new Date(),
  random: () => number = Math.random,
): Date | undefined {
  const delay = nextAttemptDelayMs(attempts, random)
  return delay === undefined ? undefined : new Date(now.getTime() + delay)
}

export function retriesExhausted(attempts: number): boolean {
  return attempts >= MAX_ATTEMPTS
}
