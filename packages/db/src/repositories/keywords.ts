import { and, eq, inArray, lt, or, sql, isNull } from 'drizzle-orm'
import type { Db } from '../client'
import { competitors, keywords } from '../schema'
import type { AccountScope } from '../scope'

/**
 * The store's search terms, and the handful of businesses it is compared
 * against.
 *
 * Two tables, one rule between them: a domain seen ranking on a results page
 * lives in `serp_snapshots` and reaches `competitors` only through a call that
 * names a `source` — so the only way a domain becomes a competitor is that
 * onboarding proposed it as a draft the merchant then edits, or the merchant
 * typed it. There is no path from a stored results page into this table.
 */

export type KeywordRow = typeof keywords.$inferSelect
export type CompetitorRow = typeof competitors.$inferSelect

/**
 * At most five business competitors per account.
 *
 * This constant is the API half of that. The other half is a database trigger
 * that takes a lock on the account row, counts, and refuses the sixth — and
 * the trigger is the authority, because it holds against a hand-written INSERT
 * and against two requests arriving at once, neither of which a count in
 * application code can survive.
 *
 * The two cannot drift: `keywords.test.ts` fills an account to this number
 * through the repository and asserts the *database* rejects the next one. Raise
 * this without changing the trigger and that test fails.
 *
 * Why five at all: each competitor is a set of paid keyword lookups every time
 * the calendar is replenished, so the cap is a spend ceiling, not a UI
 * simplification.
 */
export const BUSINESS_COMPETITOR_CAP = 5

/** Raised by `addCompetitor` when the account already holds its five. */
export class CompetitorCapReached extends Error {
  constructor(readonly accountId: string) {
    super(`account ${accountId} already holds ${BUSINESS_COMPETITOR_CAP} business competitors`)
    this.name = 'CompetitorCapReached'
  }
}

/** Postgres raises the trigger's refusal as a check violation; this is that code. */
const CHECK_VIOLATION = '23514'

export interface KeywordWrite {
  readonly term: string
  readonly language: string
  readonly country: string
  readonly volume: number | null
  readonly difficulty: number | null
  readonly cpcUsd: number | null
  readonly source: 'auto' | 'manual'
  /** When the vendor last priced this term. Null for a term nobody has priced yet. */
  readonly enrichedAt: Date | null
}

/**
 * Writes the draft keyword set, replacing the metrics on terms we already hold.
 *
 * Conflicts on `(account_id, term)` update rather than insert, because the
 * merchant may have typed by hand a term the seed call also proposed, and two
 * rows for one search would mean two purchases of the same answer. A term the
 * merchant added by hand keeps `source = 'manual'`: it is their term, and the
 * badge on the confirmation screen says so.
 */
export async function upsertKeywords(
  db: Db,
  scope: AccountScope,
  rows: readonly KeywordWrite[],
): Promise<number> {
  if (rows.length === 0) return 0
  const values = rows.map((row) => ({
    accountId: scope.accountId,
    term: row.term,
    language: row.language,
    country: row.country,
    volume: row.volume,
    difficulty: row.difficulty,
    cpc: row.cpcUsd === null ? null : row.cpcUsd.toFixed(4),
    source: row.source,
    enrichedAt: row.enrichedAt,
  }))

  const written = await db
    .insert(keywords)
    .values(values)
    .onConflictDoUpdate({
      target: [keywords.accountId, keywords.term],
      set: {
        volume: sql`excluded.volume`,
        difficulty: sql`excluded.difficulty`,
        cpc: sql`excluded.cpc`,
        language: sql`excluded.language`,
        country: sql`excluded.country`,
        enrichedAt: sql`excluded.enriched_at`,
      },
    })
    .returning({ id: keywords.id })

  return written.length
}

/**
 * Adds one term the merchant typed, unpriced.
 *
 * Unpriced on purpose: pricing it is a paid vendor call and every one of those
 * is job-side, so the row appears immediately with no metrics and the screen
 * shows a loading state against it until the enrichment job fills them in. A
 * term they have already got is returned as it stands rather than reset to
 * unpriced — re-adding a keyword is not a request to re-buy it.
 */
export async function addManualKeyword(
  db: Db,
  scope: AccountScope,
  input: { term: string; language: string; country: string },
): Promise<KeywordRow> {
  const [row] = await db
    .insert(keywords)
    .values({
      accountId: scope.accountId,
      term: input.term,
      language: input.language,
      country: input.country,
      source: 'manual',
    })
    .onConflictDoUpdate({
      target: [keywords.accountId, keywords.term],
      // A no-op update, so the existing row comes back from `returning()`.
      // `onConflictDoNothing` returns nothing at all, which would make a
      // duplicate add look like a failure to the merchant.
      set: { term: sql`excluded.term` },
    })
    .returning()

  if (!row) throw new Error('failed to add the keyword')
  return row
}

/**
 * Marks every term this account currently holds as the merchant's own — the
 * decision `T3.3` reads back as "the confirmed keyword each topic descended
 * from" (main §9.6.3). Fired once, from "Confirm profile": there is no
 * per-chip confirm step, only remove, so whatever survived to that moment is
 * what is confirmed.
 */
export async function confirmAllKeywords(db: Db, scope: AccountScope): Promise<void> {
  await db.update(keywords).set({ confirmed: true }).where(eq(keywords.accountId, scope.accountId))
}

export async function listKeywords(db: Db, scope: AccountScope): Promise<KeywordRow[]> {
  return db
    .select()
    .from(keywords)
    .where(eq(keywords.accountId, scope.accountId))
    .orderBy(sql`${keywords.volume} desc nulls last`, keywords.term)
}

/** Removes one term. Returns false when it was already gone or belongs to someone else. */
export async function removeKeyword(
  db: Db,
  scope: AccountScope,
  keywordId: string,
): Promise<boolean> {
  const removed = await db
    .delete(keywords)
    .where(and(eq(keywords.accountId, scope.accountId), eq(keywords.id, keywordId)))
    .returning({ id: keywords.id })
  return removed.length > 0
}

/**
 * The terms whose search volumes have gone stale, or were never bought.
 *
 * This is the semantic cache the vendor's own 24-hour request cache sits
 * underneath: a term priced three weeks ago is not re-bought, so a re-run of
 * onboarding or a nightly refresh costs nothing for the terms that have not
 * aged out. `staleBefore` comes from the keyword-metrics lifetime in
 * `packages/rules`.
 */
export async function keywordsNeedingEnrichment(
  db: Db,
  scope: AccountScope,
  staleBefore: Date,
  terms?: readonly string[],
): Promise<KeywordRow[]> {
  const stale = or(isNull(keywords.enrichedAt), lt(keywords.enrichedAt, staleBefore))
  const scoped =
    terms === undefined
      ? and(eq(keywords.accountId, scope.accountId), stale)
      : terms.length === 0
        ? sql`false`
        : and(eq(keywords.accountId, scope.accountId), inArray(keywords.term, [...terms]), stale)

  return db.select().from(keywords).where(scoped).orderBy(keywords.term)
}

/** The terms the merchant agreed to at confirmation — what the standing competitor suggestions are judged against. */
export async function confirmedKeywords(db: Db, scope: AccountScope): Promise<KeywordRow[]> {
  return db
    .select()
    .from(keywords)
    .where(and(eq(keywords.accountId, scope.accountId), eq(keywords.confirmed, true)))
    .orderBy(keywords.term)
}

export async function listCompetitors(db: Db, scope: AccountScope): Promise<CompetitorRow[]> {
  return db
    .select()
    .from(competitors)
    .where(eq(competitors.accountId, scope.accountId))
    .orderBy(competitors.addedAt, competitors.domainNormalized)
}

export async function countCompetitors(db: Db, scope: AccountScope): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(competitors)
    .where(eq(competitors.accountId, scope.accountId))
  return row?.count ?? 0
}

/**
 * Adds one business competitor.
 *
 * The cap is checked here *and* enforced by the database, and the two answer
 * the same question differently on purpose. The check below is what turns "you
 * already have five" into a specific message on the merchant's screen. The
 * trigger is what makes it true: it locks the account row before counting, so
 * two requests arriving at the same instant cannot each see four and each add a
 * fifth. When the trigger is the one that refuses, its error is translated into
 * the same failure, so the caller never has to know which of the two stopped
 * it.
 *
 * Re-adding a domain the account already holds returns the existing row rather
 * than failing, and does not consume a slot.
 */
export async function addCompetitor(
  db: Db,
  scope: AccountScope,
  input: { domainNormalized: string; source: 'auto' | 'manual' },
): Promise<CompetitorRow> {
  const existing = await db
    .select()
    .from(competitors)
    .where(
      and(
        eq(competitors.accountId, scope.accountId),
        eq(competitors.domainNormalized, input.domainNormalized),
      ),
    )
    .limit(1)
  if (existing[0]) return existing[0]

  if ((await countCompetitors(db, scope)) >= BUSINESS_COMPETITOR_CAP) {
    throw new CompetitorCapReached(scope.accountId)
  }

  try {
    const [row] = await db
      .insert(competitors)
      .values({
        accountId: scope.accountId,
        domainNormalized: input.domainNormalized,
        source: input.source,
      })
      .returning()
    if (!row) throw new Error('failed to add the competitor')
    return row
  } catch (error) {
    if (isCheckViolation(error)) throw new CompetitorCapReached(scope.accountId)
    throw error
  }
}

/** Removes one competitor. Returns false when it was already gone or belongs to someone else. */
export async function removeCompetitor(
  db: Db,
  scope: AccountScope,
  competitorId: string,
): Promise<boolean> {
  const removed = await db
    .delete(competitors)
    .where(and(eq(competitors.accountId, scope.accountId), eq(competitors.id, competitorId)))
    .returning({ id: competitors.id })
  return removed.length > 0
}

function isCheckViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === CHECK_VIOLATION
}
