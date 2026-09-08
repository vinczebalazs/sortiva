import {
  accountAttribution,
  autoPublishReadiness,
  intentExternalId,
  isTokenRejected,
  publishAttemptFailure,
  publishMarker,
  BundleNotBuildable,
  RemoteArticleGone,
  type Logger,
} from '@sortiva/core'
import {
  abandonPublishIntent,
  accountScope,
  confirmedRemoteArticleId,
  confirmPublishIntent,
  findArticleById,
  openPublishIntent,
  readPublishTarget,
  releasePublishIntent,
} from '@sortiva/db'
import { runtimeLogger } from '../runtime/logging'
import { storefrontDomainFor } from './address'
import { recordAttempt } from './attempts'
import { buildBundleForArticle } from './bundle'
import type { AutoPublishDeps, AutoPublishInput } from './auto-publish'
import { raiseShopifyReconnect } from './reconnect'

/**
 * Revising an article we already put on a merchant's shop.
 *
 * One rule governs the whole file, and it is the reason it is separate from the
 * first publication rather than a branch inside it: **an update names the
 * article it is revising, or it does not happen.** It never falls back to
 * creating one. A merchant who deleted the post meant to delete it, and putting
 * it back under a new address would be a post they never asked for, on their
 * own site, from software that was supposed to be revising something.
 *
 * That is also why a missing remote article is reported to the merchant rather
 * than swallowed: the correct response is theirs to make, and the product's job
 * is to say plainly that the article we were maintaining is gone.
 *
 * Every product reference is resolved again here, against the store as it is at
 * this moment — a republication is another moment the article leaves us, and
 * the values in it must be the current ones, not the ones the first publication
 * happened to render.
 */

export type RepublishOutcome =
  | { readonly status: 'updated'; readonly remoteArticleId: string; readonly revisionN: number }
  | {
      readonly status: 'skipped'
      readonly reason:
        /** We have no record of ever having published this article. Nothing to revise. */
        | 'never_published'
        | 'connection_lost'
        | 'write_scope_required'
        | 'target_blog_unresolved'
        | 'article_not_found'
        /** This revision is already claimed — another worker has it, or it is done. */
        | 'already_claimed'
    }
  | {
      readonly status: 'failed'
      readonly reason: 'remote_article_gone' | 'product_gone' | 'article_incomplete'
      readonly detail: string
    }

export interface RepublishInput extends AutoPublishInput {
  /** Which revision this is. Every republication needs a number of its own. */
  readonly revisionN: number
}

export async function republishArticleToShopify(
  deps: AutoPublishDeps,
  input: RepublishInput,
): Promise<RepublishOutcome> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(input.accountId)

  if (input.revisionN < 1) {
    throw new Error('a republication is revision 1 or later; revision 0 is the first publication')
  }

  const firstPublication = intentExternalId(input.articleId, 0)
  const remoteArticleId = await confirmedRemoteArticleId(deps.db, scope, firstPublication)
  // The condition the whole protocol turns on. Without a confirmed first
  // publication there is no remote article to revise, and this stops here
  // rather than reaching for the create path.
  if (!remoteArticleId) {
    log.info('republish_skipped', { account_id: input.accountId, article_id: input.articleId, reason: 'never_published' })
    return { status: 'skipped', reason: 'never_published' }
  }

  const target = await readPublishTarget(deps.db, scope)
  if (!target || target.invalidatedAt) return { status: 'skipped', reason: 'connection_lost' }

  const readiness = autoPublishReadiness({
    grantedScopes: target.grantedScopes,
    targetBlogId: target.targetBlogId,
  })
  if (!readiness.ok) return { status: 'skipped', reason: readiness.code }

  const article = await findArticleById(deps.db, scope, input.articleId)
  if (!article) return { status: 'skipped', reason: 'article_not_found' }

  let bodyHtml: string
  try {
    const bundle = await buildBundleForArticle(
      { db: deps.db, now: () => now },
      { accountId: input.accountId, articleId: input.articleId },
    )
    bodyHtml = bundle.html
  } catch (error) {
    if (error instanceof BundleNotBuildable) {
      await notifyRepair(deps, input, error.reason, log)
      return {
        status: 'failed',
        reason: error.reason === 'missing_product' ? 'product_gone' : 'article_incomplete',
        detail: error.message,
      }
    }
    throw error
  }

  const externalId = intentExternalId(input.articleId, input.revisionN)
  const intent = await openPublishIntent(deps.db, scope, {
    articleExternalId: externalId,
    revisionN: input.revisionN,
  })
  if (!intent) return { status: 'skipped', reason: 'already_claimed' }

  deps.checkpoint?.('republish:claimed')

  // Only the send is inside the guard, so one attempt leaves one row: with the
  // paperwork below in here too, a confirmation that threw would be written
  // down as a second, failed attempt at a revision the shop had already taken.
  let remote
  try {
    // Only the words. No address, no tags, no published state: Shopify leaves
    // an unsent field alone, so the merchant's rename, their own tags and their
    // decision to take the post down all survive this. There is no field for
    // them on an update to pass even by accident.
    remote = await deps.shopify.updateArticle({
      shop: target.shopHandle,
      accessToken: deps.cipher.decrypt(target.accessTokenCipher),
      blogId: target.targetBlogId as string,
      blogHandle: target.targetBlogHandle ?? '',
      storefrontDomain: await storefrontDomainFor(deps.db, input.accountId, target.shopHandle),
      remoteArticleId,
      title: article.title,
      bodyHtml,
      summary: article.metaDescription ?? '',
      marker: publishMarker(input.articleId),
    })
  } catch (error) {
    await recordAttempt({
      db: deps.db,
      log,
      accountId: input.accountId,
      articleId: input.articleId,
      articleExternalId: externalId,
      at: now,
      ...publishAttemptFailure(error),
    })

    if (isTokenRejected(error)) {
      // Nothing was written — Shopify refused us at the door. The claim on this
      // revision goes back so the repair is due again once the merchant has
      // reconnected, and the merchant is actually told, rather than the article
      // quietly ceasing to be maintained.
      await releasePublishIntent(deps.db, scope, externalId)
      await raiseShopifyReconnect(deps.db, {
        accountId: input.accountId,
        at: now,
        ...(deps.notifications ? { notifications: deps.notifications } : {}),
        logger: log,
      })
      return { status: 'skipped', reason: 'connection_lost' }
    }
    if (error instanceof RemoteArticleGone) {
      // The merchant deleted it. The claim is closed so no sweep retries it,
      // and nothing creates a replacement.
      await abandonPublishIntent(deps.db, scope, externalId)
      await notifyRepair(deps, input, 'remote_gone', log)
      log.warn('republish_remote_gone', {
        account_id: input.accountId,
        article_id: input.articleId,
        shopify_article_id: remoteArticleId,
      })
      return { status: 'failed', reason: 'remote_article_gone', detail: error.message }
    }
    throw error
  }

  await recordAttempt({
    db: deps.db,
    log,
    accountId: input.accountId,
    articleId: input.articleId,
    articleExternalId: externalId,
    outcome: 'succeeded',
    failureClass: null,
    at: now,
  })

  deps.checkpoint?.('republish:executed')

  await confirmPublishIntent(deps.db, scope, {
    articleExternalId: externalId,
    shopifyArticleId: remote.id,
    at: now,
  })
  log.info('article_republished', {
    account_id: input.accountId,
    article_id: input.articleId,
    revision: input.revisionN,
    shopify_article_id: remote.id,
  })
  return { status: 'updated', remoteArticleId: remote.id, revisionN: input.revisionN }
}

/**
 * Tells the merchant an article we maintain needs them.
 *
 * The repair *queue* — what to do about it, and the action card an export
 * account gets instead — is `T5.3`, and there is no repairs table in the schema
 * yet. The bell exists today, and a merchant whose published article silently
 * stopped being updated is worse served by nothing than by a line saying so.
 * Deduplicated on the article and the reason, so a sweep that retries rings once.
 */
async function notifyRepair(
  deps: AutoPublishDeps,
  input: RepublishInput,
  reason: string,
  log: Logger,
): Promise<void> {
  await deps.notifications
    ?.emit(
      'repair_needed',
      { article_id: input.articleId, reason },
      `${input.articleId}:${reason}`,
      accountAttribution(input.accountId),
    )
    .catch((error: unknown) => {
      log.warn('republish_notification_failed', {
        account_id: input.accountId,
        article_id: input.articleId,
        error: String(error),
      })
      return { created: false }
    })
}
