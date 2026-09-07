import type pg from 'pg'
import {
  accountAttribution,
  autoPublishReadiness,
  intentExternalId,
  isTokenRejected,
  publishMarker,
  sendDisposition,
  BundleNotBuildable,
  type AutoPublishBlocker,
  type ExportBundle,
  type Logger,
  type NotificationEmitter,
  type PosthogCapture,
  type ShopifyPublishProvider,
} from '@sortiva/core'
import {
  accountScope,
  confirmedRemoteArticleId,
  confirmPublishIntent,
  findArticleById,
  markArticleAutoPublished,
  openPublishIntent,
  readPublishTarget,
  releasePublishIntent,
  type Db,
} from '@sortiva/db'
import { runtimeLogger } from '../runtime/logging'
import { storefrontDomainFor } from './address'
import { buildBundleForArticle } from './bundle'
import { raiseShopifyReconnect } from './reconnect'

/**
 * Posting a finished article to the merchant's own shop.
 *
 * This is the one act in the product that writes to somebody else's property,
 * and everything about the shape of this file follows from that. It happens
 * only for a store that has separately granted posting permission and named a
 * blog. It claims the publication before sending anything, so a second worker
 * cannot race it. It sends the article carrying our own marker, so a worker
 * that dies immediately afterwards can ask the shop what happened rather than
 * guess. And it writes the article down as published only once the shop has
 * confirmed it, so the app never tells a merchant something is on their site
 * when it may be nowhere.
 *
 * The values in the post — every price, every stock state, every product
 * address — are resolved from the store's own current rows at this moment, not
 * from the research the article was written against weeks ago. That is the same
 * resolution the export download uses, called here rather than reimplemented,
 * so a downloaded copy and a posted copy of the same article cannot disagree.
 * A product that has gone since the article was written stops the publish
 * outright: an article with a hole in it is worse than one that did not appear.
 */

export interface TokenDecryptor {
  decrypt(cipherText: string): string
}

export interface AutoPublishDeps {
  readonly db: Db
  readonly pool: pg.Pool
  /** The one seam that writes to a shop. */
  readonly shopify: ShopifyPublishProvider
  /** Tokens are stored encrypted; they are decrypted here, at the point of use. */
  readonly cipher: TokenDecryptor
  readonly notifications?: NotificationEmitter
  readonly capture?: Pick<PosthogCapture, 'capture'>
  readonly now?: () => Date
  readonly logger?: Logger
  /**
   * A hook the chaos test kills the worker at. Absent in production, where the
   * points a worker can die at are wherever the process happens to end.
   */
  readonly checkpoint?: (label: string) => void
}

/** Main §14.7's observability: ids and outcome only, never article text. */
export const ARTICLE_AUTO_PUBLISHED_EVENT = 'article_published'

export type AutoPublishOutcome =
  | { readonly status: 'published'; readonly articleId: string; readonly remoteArticleId: string }
  | {
      readonly status: 'skipped'
      readonly reason:
        | AutoPublishBlocker
        /** The store's Shopify connection is gone or broken; nothing can be posted. */
        | 'connection_lost'
        /** Another worker holds this publication, or it already happened. */
        | 'already_claimed'
        | 'article_not_found'
        /** The article moved between the read and the write — discarded, or published elsewhere. */
        | 'lost_race'
    }
  | {
      readonly status: 'failed'
      readonly reason:
        /** The article names a product the store no longer has. */
        | 'product_gone'
        | 'article_incomplete'
        /** The shop turned the post away. Nothing was written; this can be tried again. */
        | 'shop_refused'
        /**
         * We could not tell whether the post landed. The claim is deliberately
         * kept so the recovery sweep asks the shop before anything is re-sent.
         */
        | 'shop_unreachable'
      readonly detail: string
    }

export interface AutoPublishInput {
  readonly accountId: string
  readonly articleId: string
}

/**
 * Assumes the caller already holds this account's lock. Publishing is one step
 * of the publish-hour run, and taking the lock again inside it would deadlock.
 */
/**
 * Everything one publish needs, gathered before anything is claimed or sent.
 *
 * Gathering first means a publish that cannot happen — a withdrawn permission,
 * a product that has gone — never leaves a claim behind for the recovery sweep
 * to worry about.
 */
interface PublishContext {
  readonly shop: string
  readonly accessToken: string
  readonly blogId: string
  /** The blog's name in its own web address — what a post's public address is built from. */
  readonly blogHandle: string
  /** The store's own domain, which is the host the address is recorded under. */
  readonly storefrontDomain: string
  readonly publishAs: 'live' | 'draft'
  readonly title: string
  readonly slug: string
  readonly summary: string
  readonly bodyHtml: string
}

type Prepared = { readonly ok: true; readonly context: PublishContext } | { readonly ok: false; readonly outcome: AutoPublishOutcome }

async function preparePublish(
  deps: AutoPublishDeps,
  input: AutoPublishInput,
  log: Logger,
  now: Date,
): Promise<Prepared> {
  const scope = accountScope(input.accountId)

  const target = await readPublishTarget(deps.db, scope)
  if (!target || target.invalidatedAt) {
    log.info('auto_publish_skipped', { account_id: input.accountId, reason: 'connection_lost' })
    return { ok: false, outcome: { status: 'skipped', reason: 'connection_lost' } }
  }

  // Asked again here and not only when the merchant switched auto-publish on: a
  // merchant can remove our posting permission in Shopify's own admin at any
  // time, and the right answer to that is to stop, not to fail halfway through
  // a post.
  const readiness = autoPublishReadiness({
    grantedScopes: target.grantedScopes,
    targetBlogId: target.targetBlogId,
  })
  if (!readiness.ok) {
    log.info('auto_publish_skipped', { account_id: input.accountId, reason: readiness.code })
    return { ok: false, outcome: { status: 'skipped', reason: readiness.code } }
  }

  const article = await findArticleById(deps.db, scope, input.articleId)
  if (!article) return { ok: false, outcome: { status: 'skipped', reason: 'article_not_found' } }

  let bundle: ExportBundle
  try {
    // The article is rendered against the store as it is *now*. Same resolution
    // the download uses, called rather than reimplemented, so a downloaded copy
    // and a posted copy cannot disagree about a price.
    bundle = await buildBundleForArticle({ db: deps.db, now: () => now }, input)
  } catch (error) {
    if (error instanceof BundleNotBuildable) {
      log.warn('auto_publish_blocked', {
        account_id: input.accountId,
        article_id: input.articleId,
        reason: error.errorClass,
        placeholders: error.placeholders.join(','),
      })
      await raiseRepair(deps, input, error.reason)
      return {
        ok: false,
        outcome: {
          status: 'failed',
          reason: error.reason === 'missing_product' ? 'product_gone' : 'article_incomplete',
          detail: error.message,
        },
      }
    }
    throw error
  }

  return {
    ok: true,
    context: {
      shop: target.shopHandle,
      accessToken: deps.cipher.decrypt(target.accessTokenCipher),
      blogId: target.targetBlogId as string,
      blogHandle: target.targetBlogHandle ?? '',
      storefrontDomain: await storefrontDomainFor(deps.db, input.accountId, target.shopHandle),
      publishAs: target.publishAs,
      title: article.title,
      slug: article.slug,
      summary: article.metaDescription ?? '',
      bodyHtml: bundle.html,
    },
  }
}

/**
 * Steps 2 and 3 — send the post, then record it — assuming the claim on this
 * publication is already held.
 *
 * Separate from claiming it because the recovery sweep gets here holding a
 * claim somebody else opened before the process died. Both callers must run the
 * same code, or the recovery path would be the one that has never been
 * exercised at the moment it is needed.
 */
export async function executePublish(
  deps: AutoPublishDeps,
  input: AutoPublishInput,
  externalId: string,
): Promise<AutoPublishOutcome> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()

  const prepared = await preparePublish(deps, input, log, now)
  if (!prepared.ok) return prepared.outcome
  return sendAndAdopt(deps, input, externalId, prepared.context, now, log)
}

async function sendAndAdopt(
  deps: AutoPublishDeps,
  input: AutoPublishInput,
  externalId: string,
  context: PublishContext,
  now: Date,
  log: Logger,
): Promise<AutoPublishOutcome> {
  // Step 2 — send it, carrying our marker, so the shop is searchable for this
  // post even if we never learn that it landed.
  let remote
  try {
    remote = await deps.shopify.createArticle({
      shop: context.shop,
      accessToken: context.accessToken,
      blogId: context.blogId,
      blogHandle: context.blogHandle,
      storefrontDomain: context.storefrontDomain,
      title: context.title,
      bodyHtml: context.bodyHtml,
      handle: context.slug,
      summary: context.summary,
      marker: publishMarker(input.articleId),
      publishAs: context.publishAs,
    })
  } catch (error) {
    return handleSendFailure(deps, input, externalId, error, now, log)
  }

  // The single most dangerous instant in the product: the post exists on the
  // merchant's shop and nothing of ours records it. A worker that dies here is
  // exactly what the recovery sweep is for.
  deps.checkpoint?.('publish:executed')

  return adoptRemoteArticle(deps, input, externalId, remote.id, remote.url, context.publishAs, now, log)
}

/**
 * Step 3 — the paperwork, whether the post was just made or found on the shop
 * afterwards by the recovery sweep.
 *
 * The article is written down as published only here, after the shop has the
 * post. Marking it earlier would tell a merchant something is on their site
 * when a crash may have left it nowhere.
 */
export async function adoptRemoteArticle(
  deps: AutoPublishDeps,
  input: AutoPublishInput,
  externalId: string,
  remoteArticleId: string,
  url: string | null,
  publishAs: 'live' | 'draft',
  now: Date,
  log: Logger,
): Promise<AutoPublishOutcome> {
  const scope = accountScope(input.accountId)

  await confirmPublishIntent(deps.db, scope, {
    articleExternalId: externalId,
    shopifyArticleId: remoteArticleId,
    at: now,
  })

  const moved = await markArticleAutoPublished(deps.db, scope, {
    articleId: input.articleId,
    url,
    at: now,
  })
  if (!moved) {
    // The post is on the shop and the claim records it, but the article row had
    // already moved on. Not a failure of the publish — logged so it is not read
    // as one.
    log.warn('auto_publish_article_moved', {
      account_id: input.accountId,
      article_id: input.articleId,
      shopify_article_id: remoteArticleId,
    })
  } else if (!moved.completedOpportunity) {
    // Same shape one level down: the post is on the shop, but the suggestion it
    // came from had already been dismissed or expired, so there was nothing
    // open left to finish.
    log.info('auto_publish_opportunity_moved', {
      account_id: input.accountId,
      article_id: input.articleId,
    })
  }

  deps.capture?.capture({
    event: ARTICLE_AUTO_PUBLISHED_EVENT,
    attribution: accountAttribution(input.accountId),
    properties: { article_id: input.articleId, delivery: 'auto', published_as: publishAs },
  })
  await deps.notifications
    ?.emit(
      'article_published',
      { article_id: input.articleId },
      input.articleId,
      accountAttribution(input.accountId),
    )
    .catch((error: unknown) => {
      // The bell is not the publish. A notification that fails must never make
      // a successful post look like a failed one and get retried.
      log.warn('auto_publish_notification_failed', {
        account_id: input.accountId,
        article_id: input.articleId,
        error: String(error),
      })
      return { created: false }
    })

  log.info('article_auto_published', {
    account_id: input.accountId,
    article_id: input.articleId,
    shopify_article_id: remoteArticleId,
    published_as: publishAs,
  })
  return { status: 'published', articleId: input.articleId, remoteArticleId }
}

/**
 * Assumes the caller already holds this account's lock. Publishing is one step
 * of the publish-hour run, and taking the lock again inside it would deadlock.
 */
export async function publishArticleToShopify(
  deps: AutoPublishDeps,
  input: AutoPublishInput,
): Promise<AutoPublishOutcome> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(input.accountId)
  const externalId = intentExternalId(input.articleId, 0)

  // Everything the post needs is gathered *before* it is claimed, so a publish
  // that cannot happen — a withdrawn permission, a product that has gone —
  // leaves no claim behind for the recovery sweep to keep asking about.
  const prepared = await preparePublish(deps, input, log, now)
  if (!prepared.ok) return prepared.outcome

  // Step 1 — claim it. The database decides who holds the publication; a second
  // worker collides here and stops rather than posting a duplicate.
  const intent = await openPublishIntent(deps.db, scope, {
    articleExternalId: externalId,
    revisionN: 0,
  })
  if (!intent) {
    // Either another worker is mid-publish, or this article was already posted
    // and its claim confirmed. Both mean: do nothing here.
    const already = await confirmedRemoteArticleId(deps.db, scope, externalId)
    log.info('auto_publish_already_claimed', {
      account_id: input.accountId,
      article_id: input.articleId,
      ...(already ? { shopify_article_id: already } : {}),
    })
    return { status: 'skipped', reason: 'already_claimed' }
  }

  deps.checkpoint?.('publish:claimed')

  return sendAndAdopt(deps, input, externalId, prepared.context, now, log)
}

/**
 * A post that did not go out, and what may be assumed about it.
 *
 * Before this existed, any hiccup at the moment of posting — a rate limit, a
 * five-hundred, a dropped connection, a withdrawn permission — left the claim
 * on the publication open and threw. Every later attempt then collided with
 * that claim, reported "already claimed" and stopped, and the merchant saw an
 * article that never appeared and never would.
 *
 * The response depends entirely on one question: could the post have landed?
 *
 * If the shop **refused** it — a dead token, a rate limit, a request it would
 * not accept — nothing was written, so the claim is handed back and the article
 * is simply due again on the next run. A dead token additionally raises the
 * reconnect the rest of the product raises, because the merchant is the only
 * person who can fix it and silence is the one response that guarantees it
 * stays broken.
 *
 * If we **cannot tell** — the connection broke, or the shop answered with its
 * own fault — the article may be on the merchant's blog right now. The claim
 * stays exactly where it is, and the recovery sweep settles it by asking the
 * shop. Handing the claim back here is the shape of the bug that posts somebody
 * the same article twice.
 */
async function handleSendFailure(
  deps: AutoPublishDeps,
  input: AutoPublishInput,
  externalId: string,
  error: unknown,
  now: Date,
  log: Logger,
): Promise<AutoPublishOutcome> {
  const detail = error instanceof Error ? error.message : String(error)

  if (sendDisposition(error) === 'unknown') {
    log.error('auto_publish_send_uncertain', {
      account_id: input.accountId,
      article_id: input.articleId,
      error: detail,
    })
    return { status: 'failed', reason: 'shop_unreachable', detail }
  }

  await releasePublishIntent(deps.db, accountScope(input.accountId), externalId)

  if (isTokenRejected(error)) {
    await raiseShopifyReconnect(deps.db, {
      accountId: input.accountId,
      at: now,
      ...(deps.notifications ? { notifications: deps.notifications } : {}),
      logger: log,
    })
    log.warn('auto_publish_skipped', { account_id: input.accountId, reason: 'connection_lost' })
    return { status: 'skipped', reason: 'connection_lost' }
  }

  log.warn('auto_publish_send_refused', {
    account_id: input.accountId,
    article_id: input.articleId,
    error: detail,
  })
  return { status: 'failed', reason: 'shop_refused', detail }
}

/**
 * Tells the merchant an article could not go out and why.
 *
 * The repair *queue* — deciding what to do about it, and the action card an
 * export account gets — is `T5.3`, and there is no repairs table in the schema
 * yet. What exists today is the bell, and a merchant whose article silently did
 * not appear is worse served by nothing than by a line saying a product in it
 * is gone. Deduplicated on the article, so a daily retry rings once.
 */
async function raiseRepair(
  deps: AutoPublishDeps,
  input: AutoPublishInput,
  reason: BundleNotBuildable['reason'],
): Promise<void> {
  await deps.notifications
    ?.emit(
      'repair_needed',
      { article_id: input.articleId, reason },
      `${input.articleId}:${reason}`,
      accountAttribution(input.accountId),
    )
    .catch(() => ({ created: false }))
}
