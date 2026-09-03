import type { NotificationType } from '../contracts/opportunities'
import { NOTIFICATION_TYPES } from '../contracts/opportunities'
import type { NotificationRefs } from './refs'

/**
 * Turns a stored notification into the sentence to show — as a copy key plus
 * the values that fill it, never as text. The words live in
 * `packages/ui/strings`; this decides which words and what goes in the gaps.
 *
 * The gap-fillers are looked up at render time, because a stored row holds
 * references only. Two consequences the product depends on:
 *
 *  - reworded or translated copy applies to every notification ever written,
 *    including ones already in a merchant's bell;
 *  - a thing that has since been deleted cannot leave a stale title on screen.
 *    When the lookup comes back empty the line falls back to a generic one that
 *    still says what happened — "an article was published" rather than the name
 *    of an article that no longer exists.
 */

/** Where one gap in a line gets its value. */
interface LineParam {
  /** The `{placeholder}` in the copy. */
  readonly param: string
  /**
   * `ref` reads the stored payload directly — used for tokens that *are* the
   * value, like the month a summary covers. `resolved` reads the render-time
   * lookup, keyed by the reference it was looked up from.
   */
  readonly from: 'ref' | 'resolved'
  readonly key: string
}

interface LineSpec {
  readonly key: string
  /** Every one must be present, or the generic line is used instead. */
  readonly required: readonly LineParam[]
}

const resolvedFrom = (key: string, param: string): LineParam => ({ param, from: 'resolved', key })

const LINES: Record<NotificationType, LineSpec> = {
  ingestion_review_ready: { key: 'notification.ingestionReviewReady', required: [] },
  opportunities_ready: {
    key: 'notification.opportunitiesReady',
    required: [resolvedFrom('count', 'count')],
  },
  new_opportunities_found: {
    key: 'notification.newOpportunitiesFound',
    required: [resolvedFrom('count', 'count')],
  },
  optimize_recommendation_ready: {
    key: 'notification.optimizeRecommendationReady',
    required: [resolvedFrom('opportunity_id', 'page')],
  },
  merchant_task_created: {
    key: 'notification.merchantTaskCreated',
    required: [resolvedFrom('opportunity_id', 'subject')],
  },
  article_published: {
    key: 'notification.articlePublished',
    required: [resolvedFrom('article_id', 'title')],
  },
  draft_ready_for_review: {
    key: 'notification.draftReadyForReview',
    required: [resolvedFrom('article_id', 'title')],
  },
  topic_held_by_gate: {
    key: 'notification.topicHeldByGate',
    required: [resolvedFrom('topic_id', 'topic')],
  },
  repair_needed: {
    key: 'notification.repairNeeded',
    required: [resolvedFrom('article_id', 'title')],
  },
  connection_lost_shopify: { key: 'notification.connectionLostShopify', required: [] },
  connection_lost_gsc: { key: 'notification.connectionLostGsc', required: [] },
  payment_failed: { key: 'notification.paymentFailed', required: [] },
  monthly_summary_ready: {
    key: 'notification.monthlySummaryReady',
    required: [{ param: 'period', from: 'ref', key: 'period' }],
  },
  export_url_reminder: {
    key: 'notification.exportUrlReminder',
    required: [resolvedFrom('article_id', 'title')],
  },
  oauth_reminder: { key: 'notification.oauthReminder', required: [] },
  account_deletion_confirmed: {
    key: 'notification.accountDeletionConfirmed',
    required: [],
  },
}

/**
 * What the render-time lookup returns, keyed by the reference it was looked up
 * from: `{ article_id: 'How to store a wool coat' }` means the article that
 * payload points at is currently called that. A key that is absent or empty
 * means the thing is gone.
 */
export type ResolvedRefs = Readonly<Record<string, string | number | undefined>>

export interface RenderedNotification {
  /** A key in `packages/ui/strings`. */
  readonly stringKey: string
  readonly params: Readonly<Record<string, string | number>>
  /** True when the referenced thing could not be found and the generic line is showing. */
  readonly generic: boolean
}

export function renderNotification(input: {
  readonly type: NotificationType
  readonly refs: NotificationRefs
  readonly resolved?: ResolvedRefs
}): RenderedNotification {
  const spec = LINES[input.type]
  if (!spec) throw new Error(`No notification line for type "${input.type}".`)

  const params: Record<string, string | number> = {}
  for (const required of spec.required) {
    const value = required.from === 'ref' ? input.refs[required.key] : input.resolved?.[required.key]
    if (value === undefined || value === null || value === '') {
      return { stringKey: genericKey(spec.key), params: {}, generic: true }
    }
    params[required.param] = value
  }
  return { stringKey: spec.key, params, generic: false }
}

function genericKey(key: string): string {
  return `${key}.generic`
}

/**
 * Every copy key the renderer can ever ask for. The test beside this file holds
 * the string catalogue against it, so a type whose line was never written is a
 * failing test rather than an exception in a merchant's bell.
 */
export function notificationStringKeys(): readonly string[] {
  const keys: string[] = []
  for (const type of NOTIFICATION_TYPES) {
    const spec = LINES[type]
    keys.push(spec.key)
    if (spec.required.length > 0) keys.push(genericKey(spec.key))
  }
  return keys
}
