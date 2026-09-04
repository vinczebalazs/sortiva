import type pg from 'pg'
import {
  readRepairOutcome,
  repairOutcome,
  type DriftKind,
  type Logger,
  type NotificationEmitter,
  type PosthogCapture,
  type RepairRoute,
  type RepairedReference,
  type ShopifyPublishProvider,
} from '@sortiva/core'
import {
  accountScope,
  closeRepairTasks,
  completeRepair,
  highestPublishedRevision,
  openRepairs,
  recordRepairProgress,
  repointArticleProductRef,
  type Db,
} from '@sortiva/db'
import type { PlannedSwap } from './sweep'
import type { TokenDecryptor } from '../publish/auto-publish'
import { republishArticleToShopify } from '../publish/republish'
import { accountLifecycleGate, mayAccountPublishingRun } from '../runtime/gate'
import { runtimeLogger } from '../runtime/logging'

/**
 * Mending a published article, and putting the mended version where it belongs.
 *
 * The mend itself is one update to one row: the article's body says "the {{p1}}
 * is the one to buy", `p1` is a pointer to a product, and repairing the page
 * means pointing it at a product the store still sells. No prose is rewritten,
 * no model is called, and the sentence still reads, which is the whole reason
 * this can happen without anybody reviewing it.
 *
 * What happens *next* is where the merchant's consent decides everything. A
 * store that asked us to publish on its behalf, and left automatic repair on,
 * gets the corrected article put back on its blog through the same two-phase
 * protocol every other publication uses — claim, send, confirm — so a worker
 * dying halfway cannot post twice. A store that publishes by downloading gets
 * nothing sent anywhere: its copy here is corrected so the download is the
 * repaired one, and the card on its dashboard is what asks it to replace the
 * live page.
 *
 * **The two halves are deliberately separate calls, and this is the file's one
 * real design decision.** Mending our copy is what makes the article stop
 * naming a product that has gone — and the moment it is mended, nothing looking
 * at current state can tell that a repair was ever needed. So a worker that
 * died between mending and republishing would leave a corrected copy here, a
 * stale article on the merchant's blog, and no way for the next pass to notice.
 * The second half is therefore driven by the open repair record rather than by
 * looking at the store again: the record says a mend happened and no
 * publication followed, and that survives any crash.
 */

export interface RepairExecutionDeps {
  readonly db: Db
  readonly pool: pg.Pool
  /** The one seam that writes to a shop. Absent on a deployment that publishes for nobody. */
  readonly shopify?: ShopifyPublishProvider
  readonly cipher?: TokenDecryptor
  readonly notifications?: NotificationEmitter
  readonly capture?: Pick<PosthogCapture, 'capture'>
  readonly logger?: Logger
  /** A point the chaos test kills the worker at. Absent in production. */
  readonly checkpoint?: (label: string) => void
}

export interface RepairMendInput {
  readonly accountId: string
  readonly opportunityId: string
  readonly kind: DriftKind
  readonly route: RepairRoute
  readonly swaps: readonly PlannedSwap[]
  readonly now: Date
}

/**
 * The first half: point every broken mention at its stand-in, and write down
 * what was changed.
 *
 * The record is written whether or not anything is going to be published,
 * because it is the record of what happened to the merchant's article — and,
 * for a store we publish for, it is also what tells the next pass that a
 * publication is still owed.
 */
export async function mendArticleReferences(
  deps: RepairExecutionDeps,
  input: RepairMendInput,
): Promise<readonly RepairedReference[]> {
  const scope = accountScope(input.accountId)
  if (input.swaps.length === 0) return []

  const repaired: RepairedReference[] = []
  for (const swap of input.swaps) {
    const moved = await repointArticleProductRef(deps.db, scope, {
      refId: swap.refId,
      fromProductId: swap.fromProductId,
      toProductId: swap.toProductId,
    })
    // Losing the guard means the mention already points somewhere else — a
    // previous attempt of this same repair got there. The swap still counts as
    // done; what must not happen is a second, different swap on top of it.
    if (moved) {
      repaired.push({
        placeholderKey: swap.placeholderKey,
        fromProductId: swap.fromProductId,
        fromProductTitle: swap.fromProductTitle,
        toProductId: swap.toProductId,
        toProductTitle: swap.toProductTitle,
        overlap: swap.overlap,
      })
    }
  }

  await recordRepairProgress(
    deps.db,
    scope,
    input.opportunityId,
    repairOutcome({
      kind: input.kind,
      route: input.route,
      repairedAt: input.now.toISOString(),
      references: repaired,
    }),
    input.now,
  )

  deps.checkpoint?.('repair:mended')
  return repaired
}

export interface SettleResult {
  /** Repairs whose corrected article is now back on the merchant's shop. */
  readonly published: number
  /** Repairs still owed a publication, and left open so the next pass tries again. */
  readonly deferred: number
}

/**
 * The second half: for every repair that mended an article and never got the
 * corrected version back onto the shop, do that now.
 *
 * Driven by the open repair records rather than by re-reading the store,
 * because a mended copy looks exactly like a copy that never needed mending. A
 * repair left half-done by a crash is therefore picked up by the next pass, and
 * one that has already been published is not touched again — the record carries
 * the revision it produced, and a record with a revision is finished.
 */
export async function settlePendingRepairs(
  deps: RepairExecutionDeps,
  input: { readonly accountId: string; readonly now: Date },
): Promise<SettleResult> {
  const log = deps.logger ?? runtimeLogger()
  const scope = accountScope(input.accountId)
  const open = await openRepairs(deps.db, scope)

  let published = 0
  let deferred = 0

  for (const repair of open) {
    const record = readRepairOutcome(repair.outcome)
    if (!record || record.route !== 'mechanical_auto' || record.revisionN !== undefined) continue

    const blocked = await publishingBlocked(deps.db, input.accountId, log)
    if (blocked) {
      // Degrade to pause, never to a worse article: the mend stands, the repair
      // stays open, and the corrected version goes out when publishing is
      // allowed again.
      deferred += 1
      log.info('repair_publish_deferred', {
        account_id: input.accountId,
        article_id: repair.articleId,
        reason: blocked,
      })
      continue
    }

    if (!(deps.shopify && deps.cipher)) {
      deferred += 1
      log.warn('repair_publish_unconfigured', {
        account_id: input.accountId,
        article_id: repair.articleId,
      })
      continue
    }

    // One number per revision, taken from the claims rather than from a counter
    // of our own: a claim is written before anything is sent, so a crashed
    // attempt has already used its number and the next try takes the one after
    // — which is what stops two attempts colliding on the claim's key.
    const revisionN = (await highestPublishedRevision(deps.db, scope, repair.articleId)) + 1

    const outcome = await republishArticleToShopify(
      {
        db: deps.db,
        pool: deps.pool,
        shopify: deps.shopify,
        cipher: deps.cipher,
        ...(deps.notifications ? { notifications: deps.notifications } : {}),
        ...(deps.capture ? { capture: deps.capture } : {}),
        ...(deps.checkpoint ? { checkpoint: deps.checkpoint } : {}),
        now: () => input.now,
        logger: log,
      },
      { accountId: input.accountId, articleId: repair.articleId, revisionN },
    )

    if (outcome.status !== 'updated') {
      // The mend stands and the repair stays open; the article on the shop is
      // not ours to force. `republishArticleToShopify` has already raised its
      // own notification for the cases a merchant has to act on.
      deferred += 1
      log.warn('repair_republish_failed', {
        account_id: input.accountId,
        article_id: repair.articleId,
        status: outcome.status,
        reason:
          outcome.status === 'skipped' || outcome.status === 'failed' ? outcome.reason : 'unknown',
      })
      continue
    }

    const closed = await completeRepair(
      deps.db,
      scope,
      repair.opportunityId,
      repairOutcome({ ...record, revisionN: outcome.revisionN }),
      input.now,
    )
    if (closed) await closeRepairTasks(deps.db, scope, repair.opportunityId, input.now)
    published += 1
    log.info('article_repaired', {
      account_id: input.accountId,
      article_id: repair.articleId,
      revision: outcome.revisionN,
      references: record.references.length,
    })
  }

  return { published, deferred }
}

/** Why publishing may not happen right now, or nothing. */
async function publishingBlocked(
  db: Db,
  accountId: string,
  log: Logger,
): Promise<string | undefined> {
  const gate = await mayAccountPublishingRun(db, accountId, log)
  if (!gate.allowed) return gate.reason === 'paused' ? gate.flag : 'switches_unreadable'
  const lifecycle = await accountLifecycleGate(db, accountId)
  if (!lifecycle.publishingAllowed) return lifecycle.stoppedBy.join(',') || 'lifecycle'
  return undefined
}
