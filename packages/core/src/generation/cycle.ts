import type { LifecycleGate } from '../lifecycle/gate'

/**
 * The daily generation cycle's decision, as a pure function of what was read.
 *
 * Two rules the product cannot afford to get wrong live here rather than in the
 * job, so they can be exercised without a database:
 *
 * **At most one article a day, and only the one planned for today.** An empty
 * day is an empty day: nothing is pulled forward from tomorrow, and a day that
 * was missed is never made up later as two articles at once. That is why the
 * caller looks for a topic on *this exact date* and hands it in already found —
 * there is no "next" topic to fall back to.
 *
 * **The order the reasons to stop are consulted in.** Operator brakes first,
 * then whether the merchant is paid up, then whether they are away, then
 * whether we can still reach their store, then whether there is anything to
 * write. The order is not cosmetic: the earlier a reason is, the less we do
 * before we find it, and the first three cost one database read each while the
 * last two cost more.
 */

/** How the day ended when nothing was written. Each names one reason, in the order they are checked. */
export type DequeueBlockReason =
  /** An operator brake, or one the spend meter raised. */
  | 'paused'
  /** The switches could not be read at all, which is treated as "stop". */
  | 'switches_unreadable'
  /** Deletion has been requested; the account is on its way out. */
  | 'deleted'
  /** Not paid up. Read access is untouched — this stops writing only. */
  | 'not_entitled'
  /** The merchant is away. */
  | 'vacation'
  /** No live Shopify connection, so there is no store to write about or to. */
  | 'shopify_disconnected'
  /** Nothing was planned for today, or today's topic has already moved on. */
  | 'no_topic_today'

export type DequeueDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: DequeueBlockReason; readonly flag?: string }

/** What the caller read, in the order it is consulted below. */
export interface DequeueInput {
  /**
   * The kill switches, already read. `flag` names which one is up.
   *
   * This is also where a spend cap lands: the sweep that watches our own
   * counters raises `account.pause_generation`, so a store that has run away
   * with the money is stopped here, by a switch in our database, with no
   * analytics service in the path.
   */
  readonly switches:
    | { readonly allowed: true }
    | { readonly allowed: false; readonly reason: 'paused'; readonly flag: string }
    | { readonly allowed: false; readonly reason: 'unreadable'; readonly detail: string }
  /**
   * Billing, vacation and deletion together. Billing comes from our own
   * `subscriptions` row and never from asking Stripe — the whole reason
   * entitlement is stored locally is that this decision must not depend on a
   * vendor answering.
   */
  readonly lifecycle: LifecycleGate
  /** Whether the store is still reachable. `lost` is a revoked or expired grant. */
  readonly shopify: 'never_connected' | 'connected' | 'lost'
  /** True only when a topic in `planned` state sits on today's date for this account. */
  readonly hasPlannedTopicToday: boolean
}

export function decideDequeue(input: DequeueInput): DequeueDecision {
  if (!input.switches.allowed) {
    return input.switches.reason === 'paused'
      ? { allowed: false, reason: 'paused', flag: input.switches.flag }
      : { allowed: false, reason: 'switches_unreadable' }
  }

  // `stoppedBy` is already ordered deletion → billing → vacation, which is the
  // order this needs; reading it rather than re-deriving keeps one answer to
  // "what does past_due mean for generation".
  for (const stop of input.lifecycle.stoppedBy) {
    if (stop === 'deletion_requested') return { allowed: false, reason: 'deleted' }
    if (stop === 'billing') return { allowed: false, reason: 'not_entitled' }
    if (stop === 'vacation') return { allowed: false, reason: 'vacation' }
  }

  if (input.shopify !== 'connected') return { allowed: false, reason: 'shopify_disconnected' }

  if (!input.hasPlannedTopicToday) return { allowed: false, reason: 'no_topic_today' }

  return { allowed: true }
}

/* ── The account's own clock ──────────────────────────────────────────────── */

/**
 * The calendar date and hour where the merchant is, not where our servers are.
 *
 * A schedule can only say "at 03:00 UTC", which is a different time of day in
 * every store's own country — so the sweep runs every hour and asks this, per
 * account, whether it is that store's moment. A zone we cannot parse falls back
 * to UTC rather than skipping the store: a store generating at the wrong hour
 * is a scheduling annoyance, a store that never generates is a broken product.
 */
export interface LocalClock {
  /** `YYYY-MM-DD` in the account's zone — the date a topic is scheduled against. */
  readonly date: string
  /** 0–23 in the account's zone. */
  readonly hour: number
}

export function localClock(now: Date, timeZone: string): LocalClock {
  const read = (zone: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now)

  let parts
  try {
    parts = read(timeZone)
  } catch {
    parts = read('UTC')
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
  }
}

/**
 * The hour, on the store's own clock, at which the day's article starts being
 * written — a fixed lead ahead of the hour it is due out, so the writer, the
 * free checks, the judge and the one repair attempt all finish first.
 *
 * Wraps backwards across midnight: a store publishing at 02:00 starts the
 * evening before, which is the same amount of runway rather than none.
 */
export function generationHourFor(publishHour: number, leadHours: number): number {
  return ((publishHour - leadHours) % 24 + 24) % 24
}

/**
 * Which calendar day's article this run is writing.
 *
 * An article belongs to the day it appears, not the day it was written. A store
 * that publishes at 02:00 starts writing at 20:00 the evening before, so asking
 * the clock at the writing moment would take Tuesday's topic on Tuesday evening
 * and put it in front of readers on Wednesday — the calendar and the store
 * permanently a day apart, with every planned day silently delivered late.
 *
 * So the day is read off the clock at the *publish* moment: now plus the same
 * lead the run started with. For the ordinary 09:00 store that is the same date
 * either way; for an after-midnight publish hour it is the following one, which
 * is exactly the day the merchant sees the article on.
 *
 * Adding real hours rather than shifting a date string is deliberate: it stays
 * correct across a daylight-saving change, where "six hours later" and "six
 * hours later on the wall clock" are different moments.
 */
export function publishDayFor(now: Date, timeZone: string, leadHours: number): string {
  return localClock(new Date(now.getTime() + leadHours * 60 * 60 * 1000), timeZone).date
}
