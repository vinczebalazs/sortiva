import type pg from 'pg'
import {
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

export interface RepairExecutionInput {
  readonly accountId: string
  readonly opportunityId: string
  readonly articleId: string
  readonly kind: DriftKind
  readonly route: RepairRoute
  readonly swaps: readonly PlannedSwap[]
  readonly now: Date
}

export type RepairExecutionResult =
  /** Mended, and where the store publishes for itself, waiting for the merchant to replace the live page. */
  | { readonly status: 'repaired'; readonly references: readonly RepairedReference[] }
  /** Mended here but not put back on the shop, and why. */
  | { readonly status: 'card'; readonly reason: string }
  /** Nothing to do — another worker got here first. */
  | { readonly status: 'noop' }

export async function applyMechanicalRepair(
  deps: RepairExecutionDeps,
  input: RepairExecutionInput,
): Promise<RepairExecutionResult> {
  const log = deps.logger ?? runtimeLogger()
  const scope = accountScope(input.accountId)

  if (input.swaps.length === 0) return { status: 'noop' }

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

  deps.checkpoint?.('repair:repointed')

  if (input.route !== 'mechanical_auto') {
    // The merchant's own copy is corrected and the card stands until they say
    // they have replaced the live page. Recorded now rather than at completion
    // so the repair log says what changed even while the card is still open.
    await writeRepairRecord(deps, scope, input, repaired, undefined, false)
    return { status: 'card', reason: 'merchant_replaces_the_live_page' }
  }

  const blocked = await publishingBlocked(deps.db, input.accountId, log)
  if (blocked) {
    // Degrade to pause, never to a worse article: the mend stands, and the
    // corrected version goes out when publishing is allowed again.
    await writeRepairRecord(deps, scope, input, repaired, undefined, false)
    log.info('repair_publish_deferred', { account_id: input.accountId, article_id: input.articleId, reason: blocked })
    return { status: 'card', reason: blocked }
  }

  if (!(deps.shopify && deps.cipher)) {
    await writeRepairRecord(deps, scope, input, repaired, undefined, false)
    log.warn('repair_publish_unconfigured', { account_id: input.accountId, article_id: input.articleId })
    return { status: 'card', reason: 'publishing_unconfigured' }
  }

  // One number per revision, taken from the claims rather than from a counter
  // of our own: a claim is written before anything is sent, so a crashed
  // attempt has already used its number and the next repair takes the one
  // after — which is what stops two attempts colliding on the claim's key.
  const revisionN = (await highestPublishedRevision(deps.db, scope, input.articleId)) + 1

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
    { accountId: input.accountId, articleId: input.articleId, revisionN },
  )

  if (outcome.status === 'updated') {
    await writeRepairRecord(deps, scope, input, repaired, outcome.revisionN, true)
    log.info('article_repaired', {
      account_id: input.accountId,
      article_id: input.articleId,
      revision: outcome.revisionN,
      references: repaired.length,
    })
    return { status: 'repaired', references: repaired }
  }

  // The mend stands and the merchant is told; the article on the shop is not
  // ours to force. `republishArticleToShopify` has already raised its own
  // notification for the cases a merchant has to act on.
  await writeRepairRecord(deps, scope, input, repaired, undefined, false)
  log.warn('repair_republish_failed', {
    account_id: input.accountId,
    article_id: input.articleId,
    status: outcome.status,
    reason: outcome.status === 'skipped' || outcome.status === 'failed' ? outcome.reason : 'unknown',
  })
  return { status: 'card', reason: outcome.status }
}

/**
 * Writes down what the repair changed.
 *
 * `finished` says whether the repair is over. It is over when the corrected
 * article is back on the merchant's shop; it is not over while a card is
 * waiting for them to replace the live page themselves, and closing it then
 * would take the card off their dashboard before they had done anything.
 */
async function writeRepairRecord(
  deps: RepairExecutionDeps,
  scope: ReturnType<typeof accountScope>,
  input: RepairExecutionInput,
  references: readonly RepairedReference[],
  revisionN: number | undefined,
  finished: boolean,
): Promise<void> {
  const record = repairOutcome({
    kind: input.kind,
    route: input.route,
    repairedAt: input.now.toISOString(),
    references,
    ...(revisionN === undefined ? {} : { revisionN }),
  })

  if (finished) {
    const closed = await completeRepair(deps.db, scope, input.opportunityId, record, input.now)
    if (closed) await closeRepairTasks(deps.db, scope, input.opportunityId, input.now)
    return
  }

  // The repair log without the repair being over: the card stays on the
  // merchant's dashboard until they say they have replaced the live page.
  await recordRepairProgress(deps.db, scope, input.opportunityId, record)
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
