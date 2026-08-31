import { z } from 'zod'

/**
 * tech §3 — "Mutations that map to guarded transitions … return `409` when the
 * guard fails ('this topic already started generating') with a machine-readable
 * `code` the UI maps to its state-conflict toasts."
 *
 * Closed enum, because the UI maps each code to specific copy: an unknown code
 * would render as a generic error at exactly the moment the user needs to know
 * what changed. Adding one is a code change in both places, deliberately.
 */
export const CONFLICT_CODES = [
  // main §2, §5 — invariant 1. The claim is an insert-with-conflict.
  'domain_already_claimed',
  // main §6.8 — the profile was confirmed by another tab or session.
  'profile_already_confirmed',
  // main §7.9 — the scan updated or expired the row under the user.
  'opportunity_already_updated',
  'opportunity_not_open',
  // main §6.6, invariant 5 — at most five, enforced in API *and* DB.
  'competitor_limit_reached',
  'competitor_is_own_domain',
  // main §10.2 / §7.9 — the per-account daily cap on recommendation generation.
  'optimize_daily_cap_reached',
  // main §8.7 — the veto/move/pin race the calendar's lock semantics define.
  'topic_already_generating',
  'topic_already_published',
  'topic_pinned',
  'calendar_day_occupied',
  'calendar_date_in_past',
  // main §9.3, §8.6 — the article's state machine.
  'article_not_in_review',
  'article_already_published',
  'article_not_rejected',
  // main §9.6.5 — a refresh inside the cooldown window.
  'refresh_within_cooldown',
  // main §9.5, invariant 21 — auto-publish needs a second consent and a resolved blog.
  'write_scope_required',
  'target_blog_unresolved',
  // main §14.4, §14.5 — degraded to pause rather than to lower quality.
  'service_paused',
] as const

export type ConflictCode = (typeof CONFLICT_CODES)[number]

export const conflictCodeSchema = z.enum(CONFLICT_CODES)

/**
 * main §4.2, invariant 16 — billing state gates generation and publishing only,
 * and **read access is never revoked**. This is a 402, not a 409: nothing about
 * the resource's state conflicts, the account simply is not entitled to start
 * new work. Kept out of `CONFLICT_CODES` so that enum stays exactly "the codes
 * tech §3's guarded transitions return".
 */
export const ENTITLEMENT_INACTIVE_CODE = 'entitlement_inactive' as const

/** main §3.2 — the preview's per-IP and global rate limits. */
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
