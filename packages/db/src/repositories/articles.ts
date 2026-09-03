import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { OVERRIDE_GATE_OUTCOME } from '@sortiva/core'
import type { Db } from '../client'
import { articles, gateDecisions } from '../schema'
import type { AccountScope, SystemScope } from '../scope'

export type ArticleRow = typeof articles.$inferSelect

/**
 * Article rows. `T4.2` wrote this shape ahead of the generation pipeline that
 * actually produces one, for `discardDraftForTopic`'s own sake (a
 * `generating`/`in_review` topic can already have a draft article row
 * pointing at it by the time it is vetoed — main §8.7's lock semantics). Its
 * own comment said production code would not call `insertArticleStub` until
 * something generated a real draft; `T4.3`'s pipeline
 * (`packages/jobs/src/generation`) is that caller now — the shape needed no
 * change, only a real title/slug/target keyword instead of placeholder ones.
 * `T4.0b` then added `body_json` and `meta_description`, and `saveDraftBody`
 * below is what writes them.
 */
export interface ArticleStubInput {
  readonly topicId: string
  readonly title: string
  readonly slug: string
  readonly targetKeyword: string | null
  readonly state: ArticleRow['state']
}

export async function insertArticleStub(
  db: Db,
  scope: AccountScope,
  input: ArticleStubInput,
  now: Date = new Date(),
): Promise<ArticleRow> {
  const [row] = await db
    .insert(articles)
    .values({
      accountId: scope.accountId,
      topicId: input.topicId,
      title: input.title,
      slug: input.slug,
      targetKeyword: input.targetKeyword,
      state: input.state,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!row) throw new Error('failed to insert the article')
  return row
}

/**
 * The finished draft, written once the writer has produced one.
 *
 * `title` and `meta_description` are written to their own columns and are
 * **not** kept inside `body_json`: the column is the one authoritative copy,
 * because that is what the calendar, the articles list, publishing and export
 * all read, and a second copy in the JSON would be a second answer to the same
 * question — the reason `productMentions` was kept out of the body too. See
 * DECISIONS 2026-09-03 T4.4.
 */
export interface DraftBodyInput {
  readonly title: string
  readonly metaDescription: string
  /** `{intro, sections, faq}` — the writer's own structure, minus the two fields above. */
  readonly body: unknown
}

export async function saveDraftBody(
  db: Db,
  scope: AccountScope,
  articleId: string,
  input: DraftBodyInput,
  now: Date = new Date(),
): Promise<ArticleRow | undefined> {
  const [row] = await db
    .update(articles)
    .set({
      title: input.title,
      metaDescription: input.metaDescription,
      bodyJson: input.body as never,
      updatedAt: now,
    })
    .where(and(eq(articles.accountId, scope.accountId), eq(articles.id, articleId)))
    .returning()
  return row
}

/**
 * A draft the quality bar turned down. Guarded to `draft`: an article already
 * in review or published is not Gate 3's to move, and a zero-row result means
 * something else owns this article now.
 */
export async function markArticleRejectedByGate(
  db: Db,
  scope: AccountScope,
  articleId: string,
  now: Date = new Date(),
): Promise<ArticleRow | undefined> {
  const [row] = await db
    .update(articles)
    .set({ state: 'rejected', updatedAt: now })
    .where(and(eq(articles.accountId, scope.accountId), eq(articles.id, articleId), eq(articles.state, 'draft')))
    .returning()
  return row
}

/**
 * "Publish anyway" — main §8.6. The flag is permanent: it is what keeps this
 * article out of the calibration data, out of pattern learning and out of any
 * claim we make about how our articles perform. Guarded to `rejected`, because
 * overriding anything else is overriding a decision that was never made.
 *
 * The article returns to `draft` so the ordinary delivery path picks it up
 * exactly as it would a draft that passed — the merchant has already given the
 * deliberate confirmation, and a second approval step would be asking twice.
 */
export async function markArticleOverridden(
  db: Db,
  scope: AccountScope,
  articleId: string,
  now: Date = new Date(),
): Promise<ArticleRow | undefined> {
  const [row] = await db
    .update(articles)
    .set({ state: 'draft', publishedViaOverride: true, updatedAt: now })
    .where(and(eq(articles.accountId, scope.accountId), eq(articles.id, articleId), eq(articles.state, 'rejected')))
    .returning()
  return row
}

/**
 * A passing draft on an account that asked to see drafts first — main §9.3.
 * Guarded to `draft`, the state it was written in; a zero-row result means a
 * veto or a discard reached it while it was being graded.
 */
export async function markArticleInReview(
  db: Db,
  scope: AccountScope,
  articleId: string,
  now: Date = new Date(),
): Promise<ArticleRow | undefined> {
  const [row] = await db
    .update(articles)
    .set({ state: 'in_review', updatedAt: now })
    .where(and(eq(articles.accountId, scope.accountId), eq(articles.id, articleId), eq(articles.state, 'draft')))
    .returning()
  return row
}

/**
 * The merchant kept it. Back to `draft`, which here means "delivery may take
 * this" — the same landing an override uses, and for the same reason: they
 * have already given their answer, and asking again at the publish hour would
 * be asking twice. Guarded to `in_review`, so approving twice does nothing the
 * second time and approving something nobody was asked about is refused.
 */
export async function approveArticleGuarded(
  db: Db,
  scope: AccountScope,
  articleId: string,
  now: Date = new Date(),
): Promise<ArticleRow | undefined> {
  const [row] = await db
    .update(articles)
    .set({ state: 'draft', updatedAt: now })
    .where(and(eq(articles.accountId, scope.accountId), eq(articles.id, articleId), eq(articles.state, 'in_review')))
    .returning()
  return row
}

/** The merchant threw it away. Guarded to `in_review` for the same reasons as approval. */
export async function discardArticleGuarded(
  db: Db,
  scope: AccountScope,
  articleId: string,
  now: Date = new Date(),
): Promise<ArticleRow | undefined> {
  const [row] = await db
    .update(articles)
    .set({ state: 'discarded', updatedAt: now })
    .where(and(eq(articles.accountId, scope.accountId), eq(articles.id, articleId), eq(articles.state, 'in_review')))
    .returning()
  return row
}

/**
 * Articles that are actually ready to go out.
 *
 * `state = 'draft'` alone does not mean that: the row is created before the
 * writer runs, so a crash between the writer and the judge leaves a `draft`
 * that has never been graded, indistinguishable by state from one that passed.
 * Something other than the state has to tell them apart, so this asks for one
 * of three things as well. Anything that publishes, exports or counts finished
 * articles must come through here rather than reading the state alone.
 *
 * The three ways a draft earns delivery:
 *
 *  1. **The quality bar passed it** — the ordinary case.
 *  2. **The merchant overruled a rejection.** "Publish anyway" sets the
 *     permanent flag and returns the article to `draft`; it deliberately does
 *     not touch the decision trail, so the only decision on that topic stays
 *     the rejection. Without this arm the one case "publish anyway" exists to
 *     serve would be the one case that never went out.
 *  3. **An override that was recorded as a decision.** Nothing writes this
 *     outcome yet. It is accepted here so that when the override route is
 *     built and records it alongside the flag, delivery already works — and
 *     still works if whoever builds it records only one of the two.
 *
 * Delivering an overridden article is the *only* thing the flag stops
 * standing in the way of. It still keeps the article out of the data the
 * quality bar is tuned against, out of pattern learning and out of every
 * claim we make about how our articles perform; those exclusions live in
 * their own queries and this changes none of them.
 */
export async function articlesReadyForDelivery(
  db: Db,
  scope: AccountScope,
  limit = 50,
): Promise<ArticleRow[]> {
  const cleared = db
    .select({ topicId: gateDecisions.topicId })
    .from(gateDecisions)
    .where(
      and(
        eq(gateDecisions.accountId, scope.accountId),
        eq(gateDecisions.gate, 3),
        inArray(gateDecisions.outcome, ['passed', OVERRIDE_GATE_OUTCOME]),
      ),
    )

  return db
    .select()
    .from(articles)
    .where(
      and(
        eq(articles.accountId, scope.accountId),
        eq(articles.state, 'draft'),
        or(inArray(articles.topicId, cleared), eq(articles.publishedViaOverride, true)),
      ),
    )
    .orderBy(desc(articles.updatedAt))
    .limit(limit)
}

export async function findArticleById(
  db: Db,
  scope: AccountScope,
  articleId: string,
): Promise<ArticleRow | undefined> {
  const [row] = await db
    .select()
    .from(articles)
    .where(and(eq(articles.accountId, scope.accountId), eq(articles.id, articleId)))
    .limit(1)
  return row
}

export async function findArticleByTopic(
  db: Db,
  scope: AccountScope,
  topicId: string,
): Promise<ArticleRow | undefined> {
  const [row] = await db
    .select()
    .from(articles)
    .where(and(eq(articles.accountId, scope.accountId), eq(articles.topicId, topicId)))
    .limit(1)
  return row
}

/** Every slug this account already has, for `stableSlug` (`packages/core/src/generation/metadata.ts`) to avoid colliding with. */
export async function slugsForAccount(db: Db, scope: AccountScope): Promise<ReadonlySet<string>> {
  const rows = await db.select({ slug: articles.slug }).from(articles).where(eq(articles.accountId, scope.accountId))
  return new Set(rows.map((r) => r.slug))
}

export interface ArticleBodyRow {
  readonly id: string
  readonly title: string
  readonly bodyJson: unknown
}

/**
 * The account's own recent article bodies, for Gate 3's near-duplicate check
 * (main §8.4: "the classic at-scale failure where article #40 sounds like
 * article #12"). Only articles that actually have a body are worth comparing
 * against, and the article being graded is excluded by the caller.
 */
export async function recentArticleBodiesForAccount(
  db: Db,
  scope: AccountScope,
  limit = 25,
): Promise<readonly ArticleBodyRow[]> {
  const rows = await db
    .select({ id: articles.id, title: articles.title, bodyJson: articles.bodyJson })
    .from(articles)
    .where(and(eq(articles.accountId, scope.accountId), isNotNull(articles.bodyJson)))
    .orderBy(desc(articles.createdAt))
    .limit(limit)
  return rows
}

export interface RelatedArticleRow {
  readonly url: string
  readonly title: string
}

/**
 * The account's most recently published articles, for the internal-link
 * requirement (main §9.2: "at least one related earlier article once any
 * exist"). Only rows with a real `published_url` qualify — an article that
 * has not published yet is nothing to link to.
 */
export async function publishedArticlesForAccount(
  db: Db,
  scope: AccountScope,
  limit = 5,
): Promise<readonly RelatedArticleRow[]> {
  const rows = await db
    .select({ url: articles.publishedUrl, title: articles.title })
    .from(articles)
    .where(and(eq(articles.accountId, scope.accountId), eq(articles.state, 'published'), isNotNull(articles.publishedUrl)))
    .orderBy(desc(articles.publishedAt))
    .limit(limit)
  return rows.filter((r): r is RelatedArticleRow => r.url !== null)
}

/** Bulk lookup for the calendar list, one round trip for every topic on the visible range rather than one per topic. */
export async function findArticlesByTopics(
  db: Db,
  scope: AccountScope,
  topicIds: readonly string[],
): Promise<ArticleRow[]> {
  if (topicIds.length === 0) return []
  return db
    .select()
    .from(articles)
    .where(and(eq(articles.accountId, scope.accountId), inArray(articles.topicId, [...topicIds])))
}

/**
 * Main §8.7's "the draft is discarded (or parked as viewable-but-unpublished)"
 * - discarded, on the same reasoning `T4.0`'s `article_state` enum already
 * gives a `discarded` value distinct from `rejected` (a quality-gate failure)
 * for. Guarded to `draft`/`in_review`: an already-`published` article is a
 * publication that already happened, and main §8.7 is explicit that a veto at
 * that point is too late to mean anything (`topic_already_published` is the
 * veto route's own guard for exactly this).
 */
export async function discardDraftForTopic(
  db: Db,
  scope: AccountScope,
  topicId: string,
  now: Date = new Date(),
): Promise<ArticleRow | undefined> {
  const [row] = await db
    .update(articles)
    .set({ state: 'discarded', updatedAt: now })
    .where(
      and(
        eq(articles.accountId, scope.accountId),
        eq(articles.topicId, topicId),
        inArray(articles.state, ['draft', 'in_review']),
      ),
    )
    .returning()
  return row
}

/** One article the dashboard's "needs you" list is about, and how long it has been waiting. */
export interface WaitingArticleRow {
  readonly articleId: string
  readonly since: Date
}

/**
 * Drafts the merchant asked to see before they publish — main §9.3's optional
 * review step. `updated_at` rather than `created_at` is the wait: the row is
 * created when generation starts and only becomes the merchant's problem when
 * the judge passes it into `in_review`.
 */
export async function articlesAwaitingReview(
  db: Db,
  scope: AccountScope,
): Promise<readonly WaitingArticleRow[]> {
  const rows = await db
    .select({ articleId: articles.id, since: articles.updatedAt })
    .from(articles)
    .where(and(eq(articles.accountId, scope.accountId), eq(articles.state, 'in_review')))
  return rows
}

/**
 * Articles a merchant downloaded and published somewhere we were never told
 * about. Without the address we cannot attribute a single click to the article,
 * so their own reporting is the thing that stays blank — which is why this is a
 * nudge and not an error.
 *
 * `publishedBefore` is the caller's cutoff so the waiting period lives in one
 * place (`packages/core`'s attention module) rather than in this query.
 */
export async function unconfirmedExportedArticles(
  db: Db,
  scope: AccountScope,
  publishedBefore: Date,
): Promise<readonly WaitingArticleRow[]> {
  const rows = await db
    .select({ articleId: articles.id, since: articles.publishedAt })
    .from(articles)
    .where(and(eq(articles.accountId, scope.accountId), ...unconfirmedExport(publishedBefore)))
  return rows.flatMap((row) => (row.since ? [{ articleId: row.articleId, since: row.since }] : []))
}

export interface UnconfirmedExportRow extends WaitingArticleRow {
  readonly accountId: string
}

/**
 * The same articles across every account, for the hourly reminder sweep.
 *
 * Unscoped by necessity and not by accident: a sweep that asked account by
 * account would have to enumerate every account first and would do one query
 * per store to find the handful that qualify. `accountsWithTimezone` above
 * carries the same reasoning for the monthly summary. Each row names the
 * account it belongs to, so everything downstream is attributed.
 */
export async function unconfirmedExportedArticlesAcrossAccounts(
  db: Db,
  _scope: SystemScope,
  publishedBefore: Date,
  limit = 500,
): Promise<readonly UnconfirmedExportRow[]> {
  const rows = await db
    .select({ accountId: articles.accountId, articleId: articles.id, since: articles.publishedAt })
    .from(articles)
    .where(and(...unconfirmedExport(publishedBefore)))
    .orderBy(articles.publishedAt)
    .limit(limit)
  return rows.flatMap((row) =>
    row.since ? [{ accountId: row.accountId, articleId: row.articleId, since: row.since }] : [],
  )
}

/**
 * Exported, live, and still missing its address. `delivery = 'export'` is the
 * whole point: an auto-published article's URL comes back from Shopify, so
 * there is nobody to ask.
 */
function unconfirmedExport(publishedBefore: Date) {
  return [
    eq(articles.delivery, 'export'),
    eq(articles.state, 'published'),
    isNull(articles.publishedUrl),
    isNotNull(articles.publishedAt),
    lt(articles.publishedAt, publishedBefore),
  ]
}

/**
 * How many articles actually went live in a month, for the monthly summary.
 *
 * Override-published articles are counted. They went live on the merchant's
 * store, and a summary that left them out would tell a merchant nothing
 * happened in a month they watched an article publish. Invariant 12 keeps them
 * out of calibration data and out of claims about how *our* articles perform —
 * `gateDecisionsForCalibration` is where that exclusion lives — and neither is
 * what this count is.
 */
export async function publishedArticleCountInMonth(
  db: Db,
  scope: AccountScope,
  window: { from: Date; to: Date },
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(articles)
    .where(
      and(
        eq(articles.accountId, scope.accountId),
        eq(articles.state, 'published'),
        gte(articles.publishedAt, window.from),
        lt(articles.publishedAt, window.to),
      ),
    )
  return row?.n ?? 0
}
