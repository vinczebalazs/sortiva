/**
 * At most three step-level retries, backing off 1m, then 5m, then 25m. The
 * jitter matters more than the intervals: without it, everything that failed
 * during a vendor outage retries in lockstep the moment the vendor returns.
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
