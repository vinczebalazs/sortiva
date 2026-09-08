import { eq, and, desc, gte, lt, lte, ne, inArray, notExists, sql } from 'drizzle-orm'
import { VETOABLE_STATES } from '@sortiva/core'
import type { Db } from '../client'
import { articles, gateDecisions, topics } from '../schema'
import type { AccountScope } from '../scope'

export type TopicRow = typeof topics.$inferSelect

export interface TopicInput {
  readonly opportunityId: string
  readonly title: string
  readonly targetKeyword: string | null
  readonly keywordCluster: string | null
  readonly intentClass: TopicRow['intentClass']
  readonly familyIds: readonly string[]
  readonly kind: TopicRow['kind']
  readonly source: TopicRow['source']
  /** The template key Gate 1 (or the scoring record) rendered this from — see DECISIONS 2026-09-03 T4.1 on why this column holds a key, not prose. */
  readonly whyLine: string
  /** What the planner ranked this at, when a planner ranked it. Absent for a topic nobody scored — a manual add. */
  readonly score?: number
  readonly scheduledDate: string
  readonly pinned: boolean
  readonly state: TopicRow['state']
}

export async function insertTopic(
  db: Db,
  scope: AccountScope,
  input: TopicInput,
  now: Date = new Date(),
): Promise<TopicRow> {
  const [row] = await db
    .insert(topics)
    .values({
      accountId: scope.accountId,
      opportunityId: input.opportunityId,
      title: input.title,
      targetKeyword: input.targetKeyword,
      keywordCluster: input.keywordCluster,
      intentClass: input.intentClass,
      familyIds: [...input.familyIds],
      kind: input.kind,
      source: input.source,
      whyLine: input.whyLine,
      // `numeric` round-trips as a string in Postgres; the column is what the
      // planner's ordering is audited against, so it is stored at full
      // precision rather than rounded on the way in.
      score: input.score === undefined ? null : String(input.score),
      scheduledDate: input.scheduledDate,
      pinned: input.pinned,
      state: input.state,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!row) throw new Error('failed to insert the topic')
  return row
}

export async function findTopic(db: Db, scope: AccountScope, topicId: string): Promise<TopicRow | undefined> {
  const [row] = await db
    .select()
    .from(topics)
    .where(and(eq(topics.accountId, scope.accountId), eq(topics.id, topicId)))
    .limit(1)
  return row
}

/** Every topic scheduled in `[from, to]`, inclusive — the calendar's own read, `GET /api/calendar`. */
export async function listTopicsInRange(
  db: Db,
  scope: AccountScope,
  from: string,
  to: string,
): Promise<TopicRow[]> {
  return db
    .select()
    .from(topics)
    .where(
      and(
        eq(topics.accountId, scope.accountId),
        gte(topics.scheduledDate, from),
        lte(topics.scheduledDate, to),
      ),
    )
}

/**
 * The dates in `[from, to]` a new placement may not land on — every row that
 * is not `vetoed`. A vetoed day is an intentional gap again (main §8.7: "the
 * calendar keeps the gap ... replenishment fills it later"), so it is the one
 * state excluded here.
 */
export async function occupiedDatesInRange(
  db: Db,
  scope: AccountScope,
  from: string,
  to: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ scheduledDate: topics.scheduledDate })
    .from(topics)
    .where(
      and(
        eq(topics.accountId, scope.accountId),
        gte(topics.scheduledDate, from),
        lte(topics.scheduledDate, to),
        ne(topics.state, 'vetoed'),
      ),
    )
  return new Set(rows.map((r) => r.scheduledDate))
}

/**
 * The furthest-out day that still has a topic waiting on it, on or after
 * `from` — how far ahead the calendar is actually planned, which is what
 * decides whether a top-up is due.
 *
 * Only `planned` counts. A day already generating, published or held back has
 * had its article; it is history, not runway.
 */
export async function furthestPlannedDate(
  db: Db,
  scope: AccountScope,
  from: string,
): Promise<string | null> {
  const [row] = await db
    .select({ scheduledDate: topics.scheduledDate })
    .from(topics)
    .where(
      and(
        eq(topics.accountId, scope.accountId),
        eq(topics.state, 'planned'),
        gte(topics.scheduledDate, from),
      ),
    )
    .orderBy(desc(topics.scheduledDate))
    .limit(1)
  return row?.scheduledDate ?? null
}

/** The non-vetoed row on this exact date, if any — what "the day is occupied" means for move and add. */
export async function findTopicOnDate(
  db: Db,
  scope: AccountScope,
  date: string,
): Promise<TopicRow | undefined> {
  const [row] = await db
    .select()
    .from(topics)
    .where(
      and(eq(topics.accountId, scope.accountId), eq(topics.scheduledDate, date), ne(topics.state, 'vetoed')),
    )
    .limit(1)
  return row
}

/**
 * The one topic the daily generation cycle may take: still `planned`, and
 * scheduled for **this exact date**.
 *
 * The equality on the date is the whole of the "keep the gap" rule. A `<=`
 * here would let an empty day reach back and take yesterday's missed topic, or
 * — worse, once the calendar is ahead of itself — let a quiet week come out as
 * a burst. An empty day returns nothing and nothing is written, which is the
 * intended outcome rather than a failure.
 *
 * `planned` is the only state offered, so a second pass on the same day finds
 * nothing: the first pass already moved the topic to `generating`.
 */
export async function findPlannedTopicOnDate(
  db: Db,
  scope: AccountScope,
  date: string,
): Promise<TopicRow | undefined> {
  const [row] = await db
    .select()
    .from(topics)
    .where(
      and(
        eq(topics.accountId, scope.accountId),
        eq(topics.scheduledDate, date),
        eq(topics.state, 'planned'),
      ),
    )
    .limit(1)
  return row
}

/**
 * The calendar entry follows its article into review — main §8.7's state
 * machine, `generating → in_review (if draft review enabled)`. Guarded on
 * `generating` so a veto that arrived while the article was being written
 * (§8.7's lock semantics) is not overwritten by a result already in flight.
 */
export async function markTopicInReviewGuarded(
  db: Db,
  scope: AccountScope,
  topicId: string,
  now: Date = new Date(),
): Promise<TopicRow | undefined> {
  const [row] = await db
    .update(topics)
    .set({ state: 'in_review', updatedAt: now })
    .where(and(eq(topics.accountId, scope.accountId), eq(topics.id, topicId), eq(topics.state, 'generating')))
    .returning()
  return row
}

/**
 * The daily job's dequeue flip, main §8.7/§14.3.1: `planned → generating`,
 * guarded so a redelivered dispatch or a second scheduler pass affects
 * nothing the first already claimed. `undefined` means the guard's zero-row
 * case — someone else already moved this topic on; the caller stops
 * (invariant 15).
 */
export async function beginGenerating(
  db: Db,
  scope: AccountScope,
  topicId: string,
  now: Date = new Date(),
): Promise<TopicRow | undefined> {
  const [row] = await db
    .update(topics)
    .set({ state: 'generating', updatedAt: now })
    .where(
      and(eq(topics.accountId, scope.accountId), eq(topics.id, topicId), eq(topics.state, 'planned')),
    )
    .returning()
  return row
}

/**
 * Gate 2 (or Gate 3, `T4.4`) held or rejected the topic mid-generation —
 * main §8.7: "a scheduled topic can still fail Gate 2/3 after generating...
 * the calendar never silently shows fewer published articles than were
 * scheduled." Guarded on `generating`, the one state this can fire from: a
 * gate runs only after the daily dequeue's `beginGenerating` flip, and a
 * concurrent veto that already moved the topic to `vetoed` must not be
 * clobbered by a gate result that was already in flight (the same race
 * `vetoTopicGuarded`'s own comment names).
 *
 * No reason is written here: `topics.veto_reason` is the merchant's own veto
 * text (main §8.7), not a gate's — the calendar already reads a gate
 * rejection's reason from `gate_decisions.reason_user_facing`, keyed by
 * `(topic_id, gate)`, per `T4.2`'s `latestGateDecisionsForTopics`. Writing
 * the same words into `veto_reason` too would give the calendar two sources
 * of truth for one sentence.
 */
export async function rejectTopicByGateGuarded(
  db: Db,
  scope: AccountScope,
  topicId: string,
  now: Date = new Date(),
): Promise<TopicRow | undefined> {
  const [row] = await db
    .update(topics)
    .set({ state: 'rejected_by_gate', updatedAt: now })
    .where(and(eq(topics.accountId, scope.accountId), eq(topics.id, topicId), eq(topics.state, 'generating')))
    .returning()
  return row
}

/**
 * The veto transition, guarded on the topic still being in one of the three
 * states main §8.7 allows a veto from (`planned`, `generating`, `in_review`).
 * `undefined` means the guard failed — the topic had already resolved, or a
 * concurrent dequeue/veto got there first (the race this card's done-when
 * names). The caller does not decide what else a veto implies (discarding a
 * draft, dismissing the opportunity, recording the fingerprint) — see
 * `packages/jobs/src/generation/veto-topic.ts`.
 */
export async function vetoTopicGuarded(
  db: Db,
  scope: AccountScope,
  topicId: string,
  reason: string | null,
  now: Date = new Date(),
): Promise<TopicRow | undefined> {
  const [row] = await db
    .update(topics)
    .set({ state: 'vetoed', vetoReason: reason, updatedAt: now })
    .where(
      and(
        eq(topics.accountId, scope.accountId),
        eq(topics.id, topicId),
        inArray(topics.state, ['planned', 'generating', 'in_review']),
      ),
    )
    .returning()
  return row
}

/** The move transition, guarded on the topic still being `planned`. */
export async function moveTopicGuarded(
  db: Db,
  scope: AccountScope,
  topicId: string,
  newDate: string,
  now: Date = new Date(),
): Promise<TopicRow | undefined> {
  const [row] = await db
    .update(topics)
    .set({ scheduledDate: newDate, updatedAt: now })
    .where(
      and(eq(topics.accountId, scope.accountId), eq(topics.id, topicId), eq(topics.state, 'planned')),
    )
    .returning()
  return row
}

/**
 * A drag onto an occupied day swaps the two dates in one transaction — ui
 * spec §6.1. `a.date`/`b.date` are each topic's own *current* date (the
 * caller has already read both rows); this function exchanges them. Both
 * halves are guarded on `planned`; if either has moved on since the caller
 * checked, the whole swap is rolled back rather than leaving one topic moved
 * and the other not.
 */
export async function swapTopicDates(
  db: Db,
  scope: AccountScope,
  a: { readonly topicId: string; readonly date: string },
  b: { readonly topicId: string; readonly date: string },
  now: Date = new Date(),
): Promise<{ readonly a: TopicRow; readonly b: TopicRow } | undefined> {
  return db.transaction(async (tx) => {
    // The calendar allows one live topic per store per day, and the two updates
    // below transiently put both topics on the same one. The rule is checked at
    // the end of this transaction instead of after each statement, so it judges
    // the swap by what it leaves behind rather than by the half-second in the
    // middle. Only this transaction asks for that; everywhere else an insert on
    // an occupied day is still refused where it happens.
    await tx.execute(sql`SET CONSTRAINTS "topics_account_live_day_excl" DEFERRED`)

    const [rowA] = await tx
      .update(topics)
      .set({ scheduledDate: b.date, updatedAt: now })
      .where(
        and(eq(topics.accountId, scope.accountId), eq(topics.id, a.topicId), eq(topics.state, 'planned')),
      )
      .returning()
    if (!rowA) return undefined

    const [rowB] = await tx
      .update(topics)
      .set({ scheduledDate: a.date, updatedAt: now })
      .where(
        and(eq(topics.accountId, scope.accountId), eq(topics.id, b.topicId), eq(topics.state, 'planned')),
      )
      .returning()
    if (!rowB) {
      // Roll the transaction back rather than leaving `a` moved with `b`
      // untouched — Postgres discards both writes when the callback throws.
      throw new SwapGuardFailed()
    }
    return { a: rowA, b: rowB }
  }).catch((error) => {
    if (error instanceof SwapGuardFailed) return undefined
    throw error
  })
}

class SwapGuardFailed extends Error {}

/** The pin/unpin transition, guarded on the topic not already `published`. */
export async function pinTopicGuarded(
  db: Db,
  scope: AccountScope,
  topicId: string,
  pinned: boolean,
  now: Date = new Date(),
): Promise<TopicRow | undefined> {
  const [row] = await db
    .update(topics)
    .set({ pinned, updatedAt: now })
    .where(
      and(eq(topics.accountId, scope.accountId), eq(topics.id, topicId), ne(topics.state, 'published')),
    )
    .returning()
  return row
}

/**
 * The calendar days whose writing started and never finished.
 *
 * A run that is killed is picked up again by the next pass on the same day. Once
 * the store's own clock has turned over, nothing looks at it: the day's dequeue
 * asks for `planned` topics on today's date, and this one is `generating` on
 * yesterday's. This read is what finds them again.
 *
 * "Never finished" is the absence of a Gate 3 decision, not the topic's state.
 * The state cannot answer it: a topic stays `generating` from the moment the
 * writing starts until the article is published, so a healthy article waiting
 * its turn to go out looks identical to an abandoned one. Reaching Gate 3 is the
 * moment a day is decided — passed, held, or repaired and passed — and a run
 * that reached it is either resolved already or resolved by a path that is not
 * this one.
 *
 * Most recent day first, so a caller that only wants the freshest gets it
 * without sorting.
 */
export async function strandedGeneratingTopicsBefore(
  db: Db,
  scope: AccountScope,
  date: string,
): Promise<TopicRow[]> {
  return db
    .select()
    .from(topics)
    .where(
      and(
        eq(topics.accountId, scope.accountId),
        eq(topics.state, 'generating'),
        lt(topics.scheduledDate, date),
        notExists(
          db
            .select({ one: sql`1` })
            .from(gateDecisions)
            .where(
              and(
                eq(gateDecisions.accountId, scope.accountId),
                eq(gateDecisions.topicId, topics.id),
                eq(gateDecisions.gate, 3),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(topics.scheduledDate))
}

/**
 * The calendar day a suggestion booked, while there is still something to call
 * off.
 *
 * A suggestion books at most one day at a time — the move onto the calendar is
 * guarded on the suggestion still being `accepted`, so a second day cannot be
 * booked while the first is live — and a day that has been rejected by the
 * quality bar or already called off has nothing left to cancel.
 *
 * A day whose article has already gone out is excluded too, and that exclusion
 * is doing real work rather than tidying: nothing in the product moves a
 * calendar day out of `generating` when its article publishes, so on state
 * alone a day that published a fortnight ago is indistinguishable from one
 * being written right now. Without this, a merchant could never say "not
 * interested" to a suggestion whose article had already appeared — the
 * cancellation would be refused for ever. The article's own row is what
 * separates the two.
 */
export async function findLiveTopicForOpportunity(
  db: Db,
  scope: AccountScope,
  opportunityId: string,
): Promise<TopicRow | undefined> {
  const [row] = await db
    .select()
    .from(topics)
    .where(
      and(
        eq(topics.accountId, scope.accountId),
        eq(topics.opportunityId, opportunityId),
        inArray(topics.state, [...VETOABLE_STATES]),
        notExists(
          db
            .select({ one: sql`1` })
            .from(articles)
            .where(
              and(
                eq(articles.accountId, scope.accountId),
                eq(articles.topicId, topics.id),
                eq(articles.state, 'published'),
              ),
            ),
        ),
      ),
    )
    .limit(1)
  return row
}
