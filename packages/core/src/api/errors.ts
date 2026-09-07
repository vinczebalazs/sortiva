import { z } from 'zod'

/**
 * When a mutation loses a race — the topic already started generating, someone
 * else confirmed the profile — the route answers 409 with one of these codes
 * rather than a message, so the UI can say something specific about what
 * actually happened.
 *
 * Closed enum, because the UI maps each code to specific copy: an unknown code
 * would render as a generic error at exactly the moment the user needs to know
 * what changed. Adding one is a code change in both places, deliberately.
 */
export const CONFLICT_CODES = [
  // One domain per account, one account per domain. The claim is an
  // insert-with-conflict rather than a check-then-insert, so two people
  // claiming the same domain at once cannot both succeed.
  'domain_already_claimed',
  // The profile was confirmed by another tab or session.
  'profile_already_confirmed',
  // The scan updated or expired the row under the user.
  'opportunity_already_updated',
  'opportunity_not_open',
  // At most five business competitors, enforced in the API *and* in the
  // database, so neither can be the only thing standing between us and a
  // sixth.
  'competitor_limit_reached',
  'competitor_is_own_domain',
  // The per-account daily cap on recommendation generation.
  'optimize_daily_cap_reached',
  // The calendar races: a topic the user is acting on has already moved on.
  'topic_already_generating',
  'topic_already_published',
  'topic_pinned',
  'calendar_day_occupied',
  'calendar_date_in_past',
  // The article's state machine.
  'article_not_in_review',
  'article_already_published',
  'article_not_rejected',
  // A refresh asked for inside the cooldown window.
  'refresh_within_cooldown',
  // Publishing on the merchant's behalf needs a second, explicit consent and a
  // blog to publish into; neither is assumed from the initial connection.
  'write_scope_required',
  'target_blog_unresolved',
  // We cannot tell which search this page competes for, so there is nothing to
  // improve it against. Its own code rather than the nearest existing one,
  // because the screen maps a code to its own sentence and ignores the message
  // we send: reusing another would tell the merchant something untrue.
  'optimize_no_target_query',
  // We paused rather than continue with lower-quality or stale data.
  'service_paused',
] as const

export type ConflictCode = (typeof CONFLICT_CODES)[number]

export const conflictCodeSchema = z.enum(CONFLICT_CODES)

/**
 * Billing state gates generation and publishing only; **read access is never
 * revoked**, so a lapsed subscriber keeps everything we already made for them.
 *
 * A 402 rather than a 409: nothing about the resource's state conflicts, the
 * account simply is not entitled to start new work. Kept out of
 * `CONFLICT_CODES` so that enum stays exactly the set of codes a lost race
 * returns.
 */
export const ENTITLEMENT_INACTIVE_CODE = 'entitlement_inactive' as const

/** The preview's per-IP and global rate limits. */
export const RATE_LIMITED_CODE = 'rate_limited' as const

/**
 * One error envelope for every route, so the client has one shape to handle.
 * `message` is for humans and may change; `code` is the contract.
 */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Field-level detail for 422s. */
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
})

export const conflictResponseSchema = z.object({
  error: z.object({
    code: conflictCodeSchema,
    message: z.string(),
  }),
})

export type ErrorResponse = z.infer<typeof errorResponseSchema>
export type ConflictResponse = z.infer<typeof conflictResponseSchema>
