import { and, asc, eq, inArray, like, lt, sql } from 'drizzle-orm'
import { publishMarker } from '@sortiva/core'
import type { Db } from '../client'
import { accountSettings, articles, publishIntents, shopifyConns } from '../schema'
import type { AccountScope, SystemScope } from '../scope'
import {
  completeOpportunityForPublishedArticle,
  type ArticlePublication,
} from './opportunity-completion'
import { markTopicPublishedForArticle } from './topic-publication'

/**
 * Everything auto-publishing reads and writes: the second Shopify grant, the
 * blog it posts to, and the claim rows that stop a crash posting twice.
 *
 * A file of its own rather than more of `connections.ts` or `delivery.ts` for
 * the same reason `delivery.ts` was: several lanes append to the older files,
 * and a new file cannot conflict with any of them.
 *
 * Two rules run through it. Nothing here can enable posting on behalf of a
 * store that has not granted it and has not chosen a blog — the check is in the
 * `WHERE` clause, not only in the caller. And a publication is claimed before
 * it is attempted, with the database's own unique index deciding who holds the
 * claim, because two workers agreeing between themselves is exactly what a
 * crash prevents.
 */

/** The one write permission, spelled here because the guard is a SQL clause. */
const PUBLISH_SCOPE = 'write_content'

export interface PublishTargetRow {
  readonly shopHandle: string
  readonly grantedScopes: readonly string[]
  /** The blog articles are posted to. Null until the merchant has chosen one. */
  readonly targetBlogId: string | null
  readonly targetBlogHandle: string | null
  /** When Shopify last rejected our token; null while the connection is good. */
  readonly invalidatedAt: Date | null
  /** Still encrypted. Decryption happens above this layer, at the point of use. */
  readonly accessTokenCipher: string
  /** Whether posts go live or wait as a Shopify draft. */
  readonly publishAs: 'live' | 'draft'
}

/**
 * Everything one publish needs to know about the store, in one read.
 *
 * One query rather than three because it is read at the publish hour and again
 * on every recovery sweep, and because the three facts have to agree with each
 * other: a token, the blog it may post to, and whether that post goes live.
 */
export async function readPublishTarget(
  db: Db,
  scope: AccountScope,
): Promise<PublishTargetRow | undefined> {
  const [row] = await db
    .select({
      shopHandle: shopifyConns.shopHandle,
      grantedScopes: shopifyConns.grantedScopes,
      targetBlogId: shopifyConns.targetBlogId,
      targetBlogHandle: shopifyConns.targetBlogHandle,
      invalidatedAt: shopifyConns.invalidatedAt,
      accessTokenCipher: shopifyConns.accessToken,
      publishAs: accountSettings.shopifyPublishAs,
    })
    .from(shopifyConns)
    .leftJoin(accountSettings, eq(accountSettings.accountId, shopifyConns.accountId))
    .where(eq(shopifyConns.accountId, scope.accountId))
    .limit(1)
  if (!row) return undefined
  return { ...row, publishAs: row.publishAs ?? 'live' }
}

/**
 * Records the second grant on the connection the merchant already has.
 *
 * Update-only, and deliberately not the insert-or-update that the install
 * callback uses: the publishing grant is a *second* conversation with a store
 * that is already connected. A store with no row has not installed us, and
 * creating one here from a redirect would be a connection nobody made.
 */
export async function recordPublishGrant(
  db: Db,
  scope: AccountScope,
  input: { shopHandle: string; accessTokenCipher: string; grantedScopes: readonly string[] },
): Promise<boolean> {
  const rows = await db
    .update(shopifyConns)
    .set({
      accessToken: input.accessTokenCipher,
      grantedScopes: [...input.grantedScopes],
      invalidatedAt: null,
    })
    .where(
      and(eq(shopifyConns.accountId, scope.accountId), eq(shopifyConns.shopHandle, input.shopHandle)),
    )
    .returning({ accountId: shopifyConns.accountId })
  return rows.length > 0
}

/**
 * The blog this store's articles go to.
 *
 * Guarded on the grant: choosing a target is only meaningful once posting has
 * been permitted, and a target recorded without permission would make the
 * "may auto-publish turn on" check pass on a store that cannot post.
 */
export async function setTargetBlog(
  db: Db,
  scope: AccountScope,
  input: { blogId: string; blogHandle: string },
): Promise<boolean> {
  const rows = await db
    .update(shopifyConns)
    .set({ targetBlogId: input.blogId, targetBlogHandle: input.blogHandle })
    .where(
      and(
        eq(shopifyConns.accountId, scope.accountId),
        sql`${PUBLISH_SCOPE} = ANY(${shopifyConns.grantedScopes})`,
      ),
    )
    .returning({ accountId: shopifyConns.accountId })
  return rows.length > 0
}

/**
 * Switches the store between downloading its articles and having them posted.
 *
 * Turning it **on** is guarded in the database as well as in the API: the row
 * only changes if the store has granted posting permission and named a blog.
 * A merchant cannot reach this state through the product without both, but the
 * guard is what makes that a property of the data rather than of one code path
 * — auto-publish with no target blog would fail every morning at the publish
 * hour with nothing the merchant could do about it.
 *
 * Turning it **off** is never guarded. Withdrawing consent has to work under
 * every condition, including a broken connection.
 */
export async function setDeliveryMode(
  db: Db,
  scope: AccountScope,
  mode: 'export' | 'auto',
): Promise<boolean> {
  if (mode === 'export') {
    const result = await db.execute(sql`
      INSERT INTO account_settings (account_id, delivery)
      VALUES (${scope.accountId}::uuid, 'export')
      ON CONFLICT (account_id) DO UPDATE SET delivery = 'export', updated_at = now()
      RETURNING account_id
    `)
    return result.rows.length > 0
  }
  // The guard is the `SELECT`: with no qualifying connection there is no row to
  // insert, so neither the insert nor the conflict update ever runs.
  const result = await db.execute(sql`
    INSERT INTO account_settings (account_id, delivery)
    SELECT c.account_id, 'auto'
      FROM shopify_conns c
     WHERE c.account_id = ${scope.accountId}::uuid
       AND c.target_blog_id IS NOT NULL
       AND ${PUBLISH_SCOPE} = ANY(c.granted_scopes)
    ON CONFLICT (account_id) DO UPDATE SET delivery = 'auto', updated_at = now()
    RETURNING account_id
  `)
  return result.rows.length > 0
}

/** Whether posts go live or wait as a Shopify draft. */
export async function setShopifyPublishAs(
  db: Db,
  scope: AccountScope,
  publishAs: 'live' | 'draft',
): Promise<void> {
  await db.execute(sql`
    INSERT INTO account_settings (account_id, shopify_publish_as)
    VALUES (${scope.accountId}::uuid, ${publishAs})
    ON CONFLICT (account_id) DO UPDATE SET shopify_publish_as = ${publishAs}, updated_at = now()
  `)
}

// ── Publication claims ──────────────────────────────────────────────────────

export type PublishIntentRow = typeof publishIntents.$inferSelect

/**
 * Claims a publication, or answers that somebody else already has.
 *
 * `undefined` is not an error: it means a second worker reached the same
 * publication, and the correct response is to stop. That is the whole of the
 * global dedupe — the database decides, rather than two workers comparing
 * notes across a crash.
 *
 * Meant to be called inside the transaction that also moves the article, so a
 * claim and the state change it stands for cannot come apart.
 */
export async function openPublishIntent(
  db: Db,
  scope: AccountScope,
  input: { articleExternalId: string; revisionN: number },
): Promise<PublishIntentRow | undefined> {
  const [row] = await db
    .insert(publishIntents)
    .values({
      articleExternalId: input.articleExternalId,
      accountId: scope.accountId,
      revisionN: input.revisionN,
    })
    .onConflictDoNothing({ target: publishIntents.articleExternalId })
    .returning()
  return row
}

/**
 * Whether a publication of *this* article is claimed and unconfirmed.
 *
 * The claim is written before anything is sent, and confirmed after the shop
 * answers, so a pending claim means the post may already be on the merchant's
 * site while our own row still calls the article a draft. Anything that would
 * tell a merchant the article was called off has to ask this first, or it
 * risks saying so about a post that is already public.
 *
 * Matched by prefix because a republication claims the same article under a
 * later revision (`sortiva-<id>#r1`); the id is fixed-length, so the prefix
 * cannot reach another article.
 */
export async function hasPendingPublishForArticle(
  db: Db,
  scope: AccountScope,
  articleId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: publishIntents.id })
    .from(publishIntents)
    .where(
      and(
        eq(publishIntents.accountId, scope.accountId),
        eq(publishIntents.state, 'pending'),
        like(publishIntents.articleExternalId, `${publishMarker(articleId)}%`),
      ),
    )
    .limit(1)
  return row !== undefined
}

/** The claim as it stands, whoever holds it. */
export async function findPublishIntent(
  db: Db,
  scope: AccountScope,
  articleExternalId: string,
): Promise<PublishIntentRow | undefined> {
  const [row] = await db
    .select()
    .from(publishIntents)
    .where(
      and(
        eq(publishIntents.accountId, scope.accountId),
        eq(publishIntents.articleExternalId, articleExternalId),
      ),
    )
    .limit(1)
  return row
}

/**
 * Writes down which remote article the claim produced.
 *
 * Guarded to a claim that is still pending, so a confirmation arriving twice —
 * the worker and the recovery sweep both getting there — writes once and the
 * second caller is told it did nothing.
 */
export async function confirmPublishIntent(
  db: Db,
  scope: AccountScope,
  input: { articleExternalId: string; shopifyArticleId: string; at?: Date },
): Promise<boolean> {
  const rows = await db
    .update(publishIntents)
    .set({
      state: 'confirmed',
      shopifyArticleId: input.shopifyArticleId,
      confirmedAt: input.at ?? new Date(),
    })
    .where(
      and(
        eq(publishIntents.accountId, scope.accountId),
        eq(publishIntents.articleExternalId, input.articleExternalId),
        eq(publishIntents.state, 'pending'),
      ),
    )
    .returning({ id: publishIntents.id })
  return rows.length > 0
}

/**
 * Gives a claim back, so the publication can be attempted again from the start.
 *
 * The row is removed rather than marked, because the claim's whole job is to be
 * the one name that can only be taken once; a row left behind under any state
 * would block every future attempt at the same publication for ever.
 *
 * **Only safe when the shop is known not to have taken the post** — it refused
 * our token, refused the request, or turned us away at the door. Releasing a
 * claim after a failure that might have landed is how the same article gets
 * posted twice, which is the one thing the claim exists to stop.
 */
export async function releasePublishIntent(
  db: Db,
  scope: AccountScope,
  articleExternalId: string,
): Promise<boolean> {
  const rows = await db
    .delete(publishIntents)
    .where(
      and(
        eq(publishIntents.accountId, scope.accountId),
        eq(publishIntents.articleExternalId, articleExternalId),
        eq(publishIntents.state, 'pending'),
      ),
    )
    .returning({ id: publishIntents.id })
  return rows.length > 0
}

/** Stops trying. The work goes to the dead-letter queue, where a person can see it. */
export async function abandonPublishIntent(
  db: Db,
  scope: AccountScope,
  articleExternalId: string,
): Promise<boolean> {
  const rows = await db
    .update(publishIntents)
    .set({ state: 'abandoned' })
    .where(
      and(
        eq(publishIntents.accountId, scope.accountId),
        eq(publishIntents.articleExternalId, articleExternalId),
        eq(publishIntents.state, 'pending'),
      ),
    )
    .returning({ id: publishIntents.id })
  return rows.length > 0
}

/**
 * The remote article a previous publication produced.
 *
 * This is what an update is conditional on: with no confirmed claim there is no
 * remote article we know of, and an update must stop rather than create one.
 */
export async function confirmedRemoteArticleId(
  db: Db,
  scope: AccountScope,
  articleExternalId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ shopifyArticleId: publishIntents.shopifyArticleId })
    .from(publishIntents)
    .where(
      and(
        eq(publishIntents.accountId, scope.accountId),
        eq(publishIntents.articleExternalId, articleExternalId),
        eq(publishIntents.state, 'confirmed'),
      ),
    )
    .limit(1)
  return row?.shopifyArticleId ?? undefined
}

/**
 * Claims that were made and never confirmed — the sweep's whole input.
 *
 * Deliberately unscoped: a sweep looks across every account by definition, and
 * each claim carries the account it belongs to so everything it then does is
 * scoped again.
 */
export async function pendingPublishIntents(
  db: Db,
  _scope: SystemScope,
  olderThan: Date,
  limit = 100,
): Promise<readonly PublishIntentRow[]> {
  return db
    .select()
    .from(publishIntents)
    .where(and(eq(publishIntents.state, 'pending'), lt(publishIntents.createdAt, olderThan)))
    .orderBy(asc(publishIntents.createdAt))
    .limit(limit)
}

/**
 * The article goes live on the merchant's own shop.
 *
 * Guarded to the same two states the export hand-over is — `draft`, and
 * `cleared_to_deliver` for an article the merchant published over a quality
 * rejection — for the same reason: a zero-row result means somebody else
 * already published it or it was discarded, and the caller must stop rather
 * than try again.
 *
 * Called only *after* the remote post is confirmed. An article marked published
 * before the shop has it would tell the merchant something is on their site
 * when a crash may have left it nowhere.
 *
 * It also closes the suggestion the article came from, in the same transaction,
 * for the reason spelled out over `markArticleDelivered`: those two are the
 * only places an article becomes published, so putting the completion in both
 * of them covers every path — the publish hour, the recovery sweep re-sending
 * a post, and the sweep adopting one it found already on the shop.
 */
export async function markArticleAutoPublished(
  db: Db,
  scope: AccountScope,
  input: { articleId: string; url: string | null; at?: Date },
): Promise<ArticlePublication | undefined> {
  const now = input.at ?? new Date()
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(articles)
      .set({
        state: 'published',
        delivery: 'auto',
        publishedUrl: input.url,
        publishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(articles.accountId, scope.accountId),
          eq(articles.id, input.articleId),
          inArray(articles.state, ['draft', 'cleared_to_deliver']),
        ),
      )
      .returning()
    if (!row) return undefined
    // Topic before opportunity — same lock order as every other path that
    // touches both, see the note over `markArticleDelivered`.
    const publishedTopic = await markTopicPublishedForArticle(tx, scope, input.articleId, now)
    const completedOpportunity = await completeOpportunityForPublishedArticle(
      tx,
      scope,
      input.articleId,
      now,
    )
    return { article: row, completedOpportunity, publishedTopic }
  })
}

/**
 * Whether this account already has a publication in flight.
 *
 * The publish hour asks before starting one. Without it, a store whose worker
 * died mid-publish would have its next morning's article claimed, collide, and
 * report a lost race every day until the sweep caught up — correct, but
 * indistinguishable in the logs from a real problem.
 */
export async function hasPendingPublish(db: Db, scope: AccountScope): Promise<boolean> {
  const [row] = await db
    .select({ id: publishIntents.id })
    .from(publishIntents)
    .where(and(eq(publishIntents.accountId, scope.accountId), eq(publishIntents.state, 'pending')))
    .limit(1)
  return row !== undefined
}
