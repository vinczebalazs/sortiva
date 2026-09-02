/**
 * How long each thing we store is kept, and why.
 *
 * Two forces meet here. One is cost: the product runs on one small Postgres and
 * a volume that only grows is a bill that only grows, so anything that is
 * history rather than record has an end date. The other is obligation: a
 * webhook payload can carry a shopper's address, so pruning it is the only
 * thing bounding how long we hold something we never wanted.
 *
 * Every rule is "delete rows older than N days, by a timestamp the table
 * already has". That shape is what makes a sweep idempotent for free: the
 * second run of the same day finds nothing the first left behind, and a sweep
 * that dies half way is simply a sweep that has not finished.
 *
 * The numbers live here rather than in `packages/rules` on purpose. That
 * package holds the thresholds that decide what the product *notices* — search
 * volumes, positions, click-through rates — and stamps its own hash on every
 * decision it influences. A retention window decides nothing about a merchant's
 * store; it is an operating policy, and putting it there would make every
 * opportunity's rules hash change when we decide to keep email records for a
 * different length of time.
 */

const DAY = 24 * 60 * 60 * 1000

/** The tables a sweep may prune, named so a caller cannot invent one. */
export type RetentionTarget =
  | 'webhook_events'
  | 'notifications'
  | 'email_sends'
  | 'request_cache'
  | 'gsc_daily'
  | 'gsc_query_daily'
  | 'verification_tokens'

export interface RetentionRule {
  readonly target: RetentionTarget
  /**
   * How old a row must be before it may go. Null means the row carries its own
   * expiry and the sweep deletes whatever has passed it, rather than measuring
   * an age itself.
   */
  readonly maxAgeDays: number | null
  /** Plain language: what is being deleted and what deleting it costs. */
  readonly why: string
}

export const RETENTION_RULES: readonly RetentionRule[] = [
  {
    target: 'webhook_events',
    maxAgeDays: 30,
    why:
      'Vendor deliveries we have already acted on. This is the only thing bounding how long a ' +
      'stored delivery body sits in the database, and some of those bodies are not ours to keep, ' +
      'so the window is a limit rather than a convenience. A store redaction request is honoured ' +
      'before this ever reaches it — see the redaction sweep, which runs first.',
  },
  {
    target: 'notifications',
    maxAgeDays: 90,
    why:
      'The bell is history, not a record of legal significance. Three months is long enough to ' +
      'answer "what happened to that article" and short enough that the table does not grow forever.',
  },
  {
    target: 'email_sends',
    maxAgeDays: 365,
    why:
      'A year of send records, kept for deliverability debugging and for answering "you never ' +
      'emailed me". Longer than the bell because a bounce argument with a mail provider is a ' +
      'months-long conversation.',
  },
  {
    target: 'request_cache',
    maxAgeDays: null,
    why:
      'Replays of paid vendor answers. Each row carries its own expiry because the useful life of ' +
      'a search-data answer and of a model answer are not the same number; the sweep deletes what ' +
      'has passed its own date.',
  },
  {
    target: 'gsc_daily',
    maxAgeDays: 487,
    why:
      'Sixteen months of daily Search Console rows per page. Google itself only serves sixteen ' +
      'months, so nothing older can ever be re-fetched — deleting it is deleting it for good. ' +
      'WARNING: the spec rolls these up into monthly aggregates first and there is no table to ' +
      'roll them up into, so today this prune loses the long-run trend rather than compacting it.',
  },
  {
    target: 'gsc_query_daily',
    maxAgeDays: 487,
    why:
      'The same sixteen months, per page and query. The larger of the two tables by far, which is ' +
      'why the window matters to the bill. Carries the same missing-roll-up warning as gsc_daily.',
  },
  {
    target: 'verification_tokens',
    maxAgeDays: null,
    why:
      'Sign-in links. Each row carries its own expiry; a spent link is deleted at the moment it is ' +
      'used, so what this clears is links nobody clicked.',
  },
]

export function retentionRule(target: RetentionTarget): RetentionRule {
  const rule = RETENTION_RULES.find((r) => r.target === target)
  if (!rule) throw new Error(`no retention rule for ${target}`)
  return rule
}

/**
 * The instant a row must be older than to be deleted, or undefined when the
 * rule says the row carries its own expiry.
 */
export function retentionCutoff(target: RetentionTarget, now: Date): Date | undefined {
  const { maxAgeDays } = retentionRule(target)
  if (maxAgeDays === null) return undefined
  return new Date(now.getTime() - maxAgeDays * DAY)
}

/**
 * How long a deleted account's domain stays blocked before anyone else may
 * claim it, so a mistaken deletion does not hand the domain to a squatter the
 * same hour.
 */
export const DOMAIN_RELEASE_GRACE_DAYS = 7

/**
 * The outside limit on erasing a deleted account's data, and on erasing a
 * store's data after a redaction request.
 *
 * Nothing waits this long. It is here as the deadline the two sweeps are
 * measured against, and as the number a test can point at.
 */
export const PURGE_DEADLINE_DAYS = 30

export function domainReleaseAt(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + DOMAIN_RELEASE_GRACE_DAYS * DAY)
}

/**
 * When a deleted account's rows are actually erased.
 *
 * The same instant the domain is released, and that is forced rather than
 * chosen: the domain row is a child of the account row, so erasing the account
 * any earlier takes the domain with it and frees it immediately — the opposite
 * of the grace window. Seven days is well inside the thirty the obligation
 * allows.
 */
export function purgeDueAt(deletedAt: Date): Date {
  return domainReleaseAt(deletedAt)
}
