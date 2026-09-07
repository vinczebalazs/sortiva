import { deriveIdempotencyKey, inputVersion } from '../runtime/idempotency'

/** The step name the day's idempotency key is derived under. Never random; see `deriveIdempotencyKey`. */
export const DAILY_GENERATION_STEP = 'daily_generation'

/**
 * "Have I already written this store's article for this calendar day?"
 *
 * Derived from the store, the topic and the date the topic sits on — never from
 * the clock at the moment of asking. That is what lets a run picked up the
 * following morning arrive at the same key as the run it is finishing, instead
 * of looking like new work and paying for the whole article twice.
 */
export function dailyGenerationKey(accountId: string, topicId: string, scheduledDate: string): string {
  return deriveIdempotencyKey(accountId, DAILY_GENERATION_STEP, inputVersion({ topicId, date: scheduledDate }))
}
