import type pg from 'pg'
import {
  accountAttribution,
  decideDelivery,
  type DeliveryBlockReason,
  type Logger,
  type NotificationEmitter,
  type PosthogCapture,
  type ShopifyPublishProvider,
} from '@sortiva/core'
import {
  accountScope,
  articlesReadyForDelivery,
  markArticleDelivered,
  readAccountSettings,
  type ArticleRow,
  type Db,
} from '@sortiva/db'
import { publishArticleToShopify, type TokenDecryptor } from './auto-publish'
import { withAccountLock } from '../runtime/lock'
import { lookupCompletedWork, recordCompletedWork } from '../runtime/ledger'
import { deriveIdempotencyKey, inputVersion } from '../runtime/idempotency'
import { accountLifecycleGate, mayAccountPublishingRun } from '../runtime/gate'
import { runtimeLogger } from '../runtime/logging'

/**
 * The publish hour: the moment a finished article stops being a draft and
 * becomes something the merchant has.
 *
 * The point of a fixed hour is that an article does **not** appear the instant
 * the quality gate passes it, which could be any time of the night. It appears
 * at nine in the morning where the audience is (or whatever hour the merchant
 * set), which is predictable for them and paced for their readers.
 *
 * On export mode, "published" means the article is now downloadable in the app
 * and the merchant is asked where they put it; nothing is written to anybody's
 * shop. On auto-publish it means the article is posted to the merchant's own
 * blog, which is a second, separate consent and goes through the two-phase
 * claim protocol in `auto-publish.ts`.
 *
 * Which of the two happens is the merchant's setting and nothing else. There is
 * no path here that exports an article for a store that asked for publishing,
 * or posts one for a store that did not.
 *
 * At most one article is handed over per pass, which combined with one pass a
 * day is what keeps publication looking like a shop that writes rather than a
 * machine that empties a queue.
 */

/** The step name the day's idempotency key is derived under. Never random. */
export const EXPORT_DELIVERY_STEP = 'export_delivery'

/** Main §14.7's observability: one event per delivery. Ids and outcome only, never article text. */
export const ARTICLE_DELIVERED_EVENT = 'article_delivered'

export interface DeliveryDeps {
  readonly db: Db
  /** The shared connection pool — the per-account lock needs a connection of its own. */
  readonly pool: pg.Pool
  /**
   * The one seam that writes to a merchant's shop, and the key that unlocks
   * their token. Optional because an export-only deployment needs neither: an
   * auto-publish store on a process without them stops rather than being
   * exported instead, which would deliver in a mode the merchant did not choose.
   */
  readonly shopify?: ShopifyPublishProvider
  readonly cipher?: TokenDecryptor
  readonly notifications?: NotificationEmitter
  readonly capture?: Pick<PosthogCapture, 'capture'>
  readonly now?: () => Date
  readonly logger?: Logger
}

export type DeliveryOutcome =
  /** Nothing was handed over, and why. */
  | {
      readonly status: 'skipped'
      readonly reason:
        | DeliveryBlockReason
        | 'lost_race'
        /** An auto-publish store on a process with no way to write to a shop. */
        | 'auto_publish_unconfigured'
        /** Auto-publish stopped for a reason of its own; `auto-publish.ts` logged which. */
        | 'auto_publish_blocked'
    }
  /** This hour's delivery already happened; nothing ran. */
  | { readonly status: 'already_done'; readonly articleId: string | null }
  | {
      readonly status: 'delivered'
      readonly articleId: string
      /** Which way it went out: downloadable in the app, or posted to the shop. */
      readonly delivery: 'export' | 'auto'
    }

/** What the ledger keeps, so a redelivered job can answer without acting again. */
interface DeliveryRecord {
  readonly articleId: string | null
}

export interface DeliveryInput {
  readonly accountId: string
  /** The store's own date this delivery belongs to — part of the derived key. */
  readonly date: string
}

export async function runExportDeliveryForAccount(
  deps: DeliveryDeps,
  input: DeliveryInput,
): Promise<DeliveryOutcome> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(input.accountId)

  const outcome = await withAccountLock(deps.pool, input.accountId, async () => {
    const settings = await readAccountSettings(deps.db, scope)
    const auto = settings.delivery === 'auto'
    if (auto && !(deps.shopify && deps.cipher)) {
      // Waiting is visible and correct; exporting instead would deliver in a
      // mode the merchant did not choose, and marking the article published
      // with no address would make it look posted when nothing was.
      log.warn('delivery_auto_publish_unconfigured', {
        account_id: input.accountId,
        date: input.date,
      })
      return { status: 'skipped', reason: 'auto_publish_unconfigured' } as const
    }

    const [switches, lifecycle] = await Promise.all([
      mayAccountPublishingRun(deps.db, input.accountId, log),
      accountLifecycleGate(deps.db, input.accountId),
    ])

    // Cleared for delivery means graded and passed, approved after review, or
    // published over a rejection on the merchant's own instruction. The state
    // alone cannot say which: a draft exists before the writer has run.
    const ready = await articlesReadyForDelivery(deps.db, scope)

    const decision = decideDelivery({ switches, lifecycle, hasArticleReady: ready.length > 0 })
    if (!decision.allowed) {
      log.info('delivery_skipped', {
        account_id: input.accountId,
        date: input.date,
        reason: decision.reason,
        ...(decision.flag ? { flag: decision.flag } : {}),
      })
      return { status: 'skipped', reason: decision.reason } as const
    }

    const key = deriveIdempotencyKey(
      input.accountId,
      EXPORT_DELIVERY_STEP,
      inputVersion({ date: input.date }),
    )
    const done = await lookupCompletedWork(deps.db, key)
    if (done) {
      const record = (done.outputRef ?? { articleId: null }) as DeliveryRecord
      log.info('delivery_already_done', { account_id: input.accountId, date: input.date })
      return { status: 'already_done', articleId: record.articleId } as const
    }

    // One a day. A merchant who approved three drafts at once has three days of
    // publishing ahead rather than one morning of it, and the oldest goes
    // first so nothing waits for ever behind newer work.
    const next = oldestFirst(ready)[0] as ArticleRow

    if (auto) {
      // The write to the merchant's shop, under their second consent, through
      // the claim protocol. The article is moved to `published` inside that
      // path and only once the shop has confirmed the post — never before.
      const published = await publishArticleToShopify(
        {
          db: deps.db,
          pool: deps.pool,
          shopify: deps.shopify as NonNullable<DeliveryDeps['shopify']>,
          cipher: deps.cipher as NonNullable<DeliveryDeps['cipher']>,
          ...(deps.notifications ? { notifications: deps.notifications } : {}),
          ...(deps.capture ? { capture: deps.capture } : {}),
          now: () => now,
          logger: log,
        },
        { accountId: input.accountId, articleId: next.id },
      )
      if (published.status !== 'published') {
        // Deliberately no ledger entry: nothing was delivered, so tomorrow's
        // run must be free to try this article again once whatever stopped it
        // — a withdrawn permission, a product that has gone — is fixed.
        return { status: 'skipped', reason: 'auto_publish_blocked' } as const
      }
      await recordCompletedWork(deps.db, key, { articleId: next.id } satisfies DeliveryRecord)
      return { status: 'delivered', articleId: next.id, delivery: 'auto' } as const
    }

    const delivered = await markArticleDelivered(deps.db, scope, next.id, 'export', now)
    if (!delivered) {
      // Zero rows: discarded, or already delivered, between the read and the
      // write. Stop rather than reach for the next one — the day's turn has
      // been taken by whatever moved it.
      log.info('delivery_lost_race', { account_id: input.accountId, article_id: next.id })
      return { status: 'skipped', reason: 'lost_race' } as const
    }

    await recordCompletedWork(deps.db, key, { articleId: delivered.id } satisfies DeliveryRecord)
    log.info('article_delivered', {
      account_id: input.accountId,
      date: input.date,
      article_id: delivered.id,
      delivery: 'export',
    })
    return { status: 'delivered', articleId: delivered.id, delivery: 'export' } as const
  })

  // Auto-publish reports itself, from the moment the shop confirmed the post.
  // Reporting it here as well would count one article twice.
  if (outcome.status === 'delivered' && outcome.delivery === 'export') {
    deps.capture?.capture({
      event: ARTICLE_DELIVERED_EVENT,
      attribution: accountAttribution(input.accountId),
      properties: { article_id: outcome.articleId, delivery: 'export' },
    })
  }

  return outcome
}

/** Oldest first, so a draft approved a week ago goes before one approved this morning. */
function oldestFirst(articles: readonly ArticleRow[]): readonly ArticleRow[] {
  return [...articles].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}
