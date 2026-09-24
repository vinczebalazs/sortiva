import {
  articleIdFromIntentExternalId,
  autoPublishReadiness,
  isTokenRejected,
  publishMarker,
  recoveryDecision,
  revisionFromIntentExternalId,
  RECOVERY_ABANDON_AFTER_MS,
  RECOVERY_GRACE_MS,
  type Logger,
} from '@sortiva/core'
import {
  abandonPublishIntent,
  accountScope,
  pendingPublishIntents,
  readPublishTarget,
  systemScope,
  type PublishIntentRow,
} from '@sortiva/db'
import { deadLetter } from '../runtime/dlq'
import { recordAttempt } from './attempts'
import { tryWithAccountLock } from '../runtime/lock'
import { runtimeLogger } from '../runtime/logging'
import { storefrontDomainFor } from './address'
import { adoptRemoteArticle, executePublish, type AutoPublishDeps } from './auto-publish'
import { raiseShopifyReconnect } from './reconnect'
import { republishArticleToShopify } from './republish'

/**
 * The sweep that makes a crash mid-publish cost nothing.
 *
 * Between claiming a publication and recording that it happened there is an
 * instant where the article is on the merchant's shop and nothing of ours knows
 * it. A process that dies there leaves a claim with no answer. The naive repair
 * — try again — is exactly how a merchant ends up with the same article posted
 * twice.
 *
 * So this never re-sends without first **asking the shop**. Every post carries
 * our own marker, so "did it land?" is a question with an answer: found means
 * the post is there and only our record of it was lost, and the right response
 * is to adopt it; not found means the post never landed, and the right response
 * is to send it. There is no third case and no path that skips the question.
 *
 * A claim nobody can settle is not retried for ever. After three sweeps it is
 * abandoned and put in the dead-letter queue, where a person sees it — an
 * automated publisher that keeps trying against a shop that keeps refusing is
 * worse than one that stops and says so.
 */

export const PUBLISH_RECOVERY_STEP = 'publish_recovery'

export interface RecoverySummary {
  readonly considered: number
  readonly adopted: number
  readonly reExecuted: number
  readonly abandoned: number
  readonly skipped: number
}

/**
 * Runs one pass. Each claim is handled under its own account's lock, taken
 * without blocking: a store whose publish-hour worker is still running is busy,
 * and the sweep runs again in five minutes.
 */
export async function sweepPublishRecovery(deps: AutoPublishDeps): Promise<RecoverySummary> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()

  const claims = await pendingPublishIntents(
    deps.db,
    systemScope('the recovery sweep looks for unconfirmed publications across every account'),
    new Date(now.getTime() - RECOVERY_GRACE_MS),
  )

  let adopted = 0
  let reExecuted = 0
  let abandoned = 0
  let skipped = 0

  for (const claim of claims) {
    // One store's failure is one store's failure. A dead token or a shop that
    // will not answer used to throw out of here and end the pass, so every
    // other store's interrupted publication went unsettled for as long as the
    // first store stayed broken.
    const outcome = await tryWithAccountLock(deps.pool, claim.accountId, async () => {
      try {
        return await recoverOneClaim(deps, claim, now, log)
      } catch (error) {
        if (isTokenRejected(error)) {
          await raiseShopifyReconnect(deps.db, {
            accountId: claim.accountId,
            at: now,
            ...(deps.notifications ? { notifications: deps.notifications } : {}),
            logger: log,
          })
        } else {
          log.error('publish_recovery_claim_failed', {
            account_id: claim.accountId,
            article_external_id: claim.articleExternalId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        // Left pending on purpose. The claim is only ever settled by an answer
        // from the shop, and we did not get one.
        return 'skipped' as ClaimOutcome
      }
    })
    if (outcome === undefined || outcome === 'skipped') skipped += 1
    else if (outcome === 'adopted') adopted += 1
    else if (outcome === 're_executed') reExecuted += 1
    else abandoned += 1
  }

  log.info('publish_recovery_sweep_complete', {
    considered: claims.length,
    adopted,
    re_executed: reExecuted,
    abandoned,
    skipped,
  })
  return { considered: claims.length, adopted, reExecuted, abandoned, skipped }
}

type ClaimOutcome = 'adopted' | 're_executed' | 'abandoned' | 'skipped'

async function recoverOneClaim(
  deps: AutoPublishDeps,
  claim: PublishIntentRow,
  now: Date,
  log: Logger,
): Promise<ClaimOutcome> {
  const articleId = articleIdFromIntentExternalId(claim.articleExternalId)
  if (!articleId) {
    // A claim whose name we cannot read is not something to guess about.
    log.error('publish_recovery_unreadable_claim', {
      account_id: claim.accountId,
      article_external_id: claim.articleExternalId,
    })
    return 'skipped'
  }

  const scope = accountScope(claim.accountId)
  const ageMs = now.getTime() - claim.createdAt.getTime()
  const revisionN = revisionFromIntentExternalId(claim.articleExternalId)
  const input = { accountId: claim.accountId, articleId }

  const target = await readPublishTarget(deps.db, scope)
  const ready =
    target && !target.invalidatedAt
      ? autoPublishReadiness({
          grantedScopes: target.grantedScopes,
          targetBlogId: target.targetBlogId,
        })
      : { ok: false as const, code: 'write_scope_required' as const }
  const auth = ready.ok && target ? await deps.authFor(claim.accountId) : undefined
  if (!ready.ok || !target || !auth) {
    // We cannot ask the shop anything without a working connection, and asking
    // is the one thing that must happen before re-sending. Left pending; if the
    // connection never comes back the claim ages out and is abandoned below on
    // a later pass.
    if (ageMs >= RECOVERY_ABANDON_AFTER_MS)
      return abandonClaim(deps, claim, 'connection_lost', now, log)
    return 'skipped'
  }

  // A revision is an update, and an update of the same content is naturally
  // repeatable: re-issuing it produces the same article rather than a second
  // one. So it needs no remote lookup — but it does still refuse to create,
  // which is what keeps a deleted remote article from being silently reposted.
  if (revisionN > 0) {
    if (ageMs >= RECOVERY_ABANDON_AFTER_MS)
      return abandonClaim(deps, claim, 'update_unrecoverable', now, log)
    // Under the claim this sweep is holding, not a new one. Asking for a second
    // claim on the same revision collides with the one the dead worker left,
    // reports "already claimed", and does nothing — for twenty-five minutes,
    // until the claim ages out and a mend nobody had a problem with is
    // abandoned into the dead-letter queue.
    const outcome = await republishArticleToShopify(deps, { ...input, revisionN, claimHeld: true })
    return outcome.status === 'updated' ? 're_executed' : 'skipped'
  }

  let found
  try {
    found = await deps.shopify.findArticleByMarker({
      auth,
      storefrontDomain: await storefrontDomainFor(deps.db, claim.accountId, target.shopHandle),
      marker: publishMarker(articleId),
      // Nothing posted before the claim was opened can be ours, which is what
      // lets the shop narrow years of posts to the few written since. Without
      // it the only honest search is every article the shop has.
      notBefore: claim.createdAt,
    })
  } catch (error) {
    // The question itself failed — the shop was unreachable, or the search ran
    // out of pages. The claim may not be answered by guessing, so it waits; but
    // it must not wait for ever, or one store's unanswerable claim holds up
    // every article queued behind it indefinitely.
    if (ageMs >= RECOVERY_ABANDON_AFTER_MS) {
      return abandonClaim(deps, claim, 'lookup_unrecoverable', now, log)
    }
    log.warn('publish_recovery_lookup_failed', {
      account_id: claim.accountId,
      article_id: articleId,
      error: error instanceof Error ? error.message : String(error),
    })
    return 'skipped'
  }

  const decision = recoveryDecision({ ageMs, remoteArticleId: found?.id })
  switch (decision.action) {
    case 'wait':
      return 'skipped'

    case 'adopt': {
      // The post landed; only our record of it was lost.
      log.info('publish_recovery_adopted', {
        account_id: claim.accountId,
        article_id: articleId,
        shopify_article_id: decision.remoteArticleId,
      })
      await adoptRemoteArticle(
        deps,
        input,
        claim.articleExternalId,
        decision.remoteArticleId,
        found?.url ?? null,
        target.publishAs,
        now,
        log,
      )
      return 'adopted'
    }

    case 'execute': {
      // The shop has said it does not have the post. Only now is sending it
      // again safe.
      log.info('publish_recovery_re_executing', { account_id: claim.accountId, article_id: articleId })
      const outcome = await executePublish(deps, input, claim.articleExternalId)
      return outcome.status === 'published' ? 're_executed' : 'skipped'
    }

    case 'abandon':
      return abandonClaim(deps, claim, 'recovery_exhausted', now, log)
  }
}

/**
 * Stops trying, and leaves behind everything a person needs to finish the job
 * by hand: which publication, under which key, and why it was given up on.
 */
async function abandonClaim(
  deps: AutoPublishDeps,
  claim: PublishIntentRow,
  errorClass: string,
  now: Date,
  log: Logger,
): Promise<ClaimOutcome> {
  const closed = await abandonPublishIntent(
    deps.db,
    accountScope(claim.accountId),
    claim.articleExternalId,
  )
  if (!closed) return 'skipped'

  // The fourth and last way a publication can end, and the only one this sweep
  // owns. Written under the same word the dead-letter entry below carries, so
  // an operator matching an incident against the counts is reading one
  // vocabulary rather than two.
  await recordAttempt({
    db: deps.db,
    log,
    accountId: claim.accountId,
    articleId: articleIdFromIntentExternalId(claim.articleExternalId) ?? null,
    articleExternalId: claim.articleExternalId,
    outcome: 'abandoned',
    failureClass: errorClass,
    at: now,
  })

  await deadLetter(deps.db, {
    accountId: claim.accountId,
    step: PUBLISH_RECOVERY_STEP,
    idempotencyKey: claim.articleExternalId,
    errorClass,
    lastError: `the publication claimed as ${claim.articleExternalId} could not be settled`,
    attempts: 3,
    inputRefs: {
      article_external_id: claim.articleExternalId,
      revision_n: claim.revisionN,
      article_id: articleIdFromIntentExternalId(claim.articleExternalId) ?? null,
    },
    firstFailedAt: claim.createdAt,
  })
  log.error('publish_recovery_abandoned', {
    account_id: claim.accountId,
    article_external_id: claim.articleExternalId,
    reason: errorClass,
  })
  return 'abandoned'
}
