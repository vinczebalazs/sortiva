import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Db } from '../client'
import { articles, gateDecisions } from '../schema'
import type { AccountScope } from '../scope'

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
 * The Gate 3 decision on its topic is what tells them apart, so this asks both
 * questions at once. Anything that publishes, exports or counts finished
 * articles must come through here rather than reading the state alone.
 */
export async function articlesReadyForDelivery(
  db: Db,
  scope: AccountScope,
  limit = 50,
): Promise<ArticleRow[]> {
  const passed = db
    .select({ topicId: gateDecisions.topicId })
    .from(gateDecisions)
    .where(
      and(
        eq(gateDecisions.accountId, scope.accountId),
        eq(gateDecisions.gate, 3),
        eq(gateDecisions.outcome, 'passed'),
      ),
    )

  return db
    .select()
    .from(articles)
    .where(
      and(
        eq(articles.accountId, scope.accountId),
        eq(articles.state, 'draft'),
        inArray(articles.topicId, passed),
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
