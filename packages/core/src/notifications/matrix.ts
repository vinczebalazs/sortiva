import { NOTIFICATION_TYPES, type NotificationType } from '../contracts/opportunities'

/**
 * Which channels one domain event reaches, as data rather than as branches
 * scattered through the pipeline. One row per notification type; the UI spec's
 * notification matrix is the source, and the table-test beside this file holds
 * each row against it.
 *
 * A record is written to `notifications` for **every** type — that is what the
 * bell's history is — so this table says *where the merchant meets it*, not
 * whether a row exists. A connection loss is a banner and a bell entry both;
 * losing the banner treatment would not lose the history.
 */

/** Where the merchant actually encounters the event, beyond the bell's history. */
export type InAppSurface =
  /** The bell list, and nothing more prominent. */
  | 'bell'
  /** A banner across the app: the thing it reports has stopped the pipeline. */
  | 'banner'
  /** A card that persists on the dashboard until the merchant acts. */
  | 'dashboard_card'
  /** The dashboard's attention list — computed live, never a stored row (see `attention.ts`). */
  | 'attention_list'
  /** The calendar entry for the day it concerns. */
  | 'calendar_card'

export type EmailPolicy =
  /** Sent as its own email whenever the event happens. */
  | 'always'
  /** Sent only if the merchant turned it on. */
  | 'opt_in'
  /** No email of its own; it is one line in the monthly summary instead. */
  | 'monthly_summary_only'
  /** Never emailed. */
  | 'none'

/**
 * What supplies the `dedupe_key` half of the unique
 * `(account_id, type, dedupe_key)` triple. A retried worker recomputes the same
 * key from the same inputs, so its second insert is a no-op instead of a second
 * ring of the bell — which is the whole reason the key is derived and never
 * random.
 */
export type DedupeKeySource =
  /** The value of this reference in the payload, e.g. `article_id`. */
  | { readonly kind: 'ref'; readonly ref: string }
  /** The ISO week the scan ran in, so one scan-week notifies once. */
  | { readonly kind: 'iso_week' }
  /** The calendar month the summary covers, `YYYY-MM`. */
  | { readonly kind: 'year_month' }
  /**
   * The account plus the threshold that fired, so an hourly sweep over the same
   * still-unresolved state re-derives the same key every hour and sends once.
   */
  | { readonly kind: 'sweep_threshold' }

export interface NotificationChannelRow {
  readonly type: NotificationType
  readonly surface: InAppSurface
  readonly email: EmailPolicy
  /** Whether that email is on for an account that has never touched a setting. */
  readonly emailDefaultOn: boolean
  /**
   * Whether the merchant may turn the email off. Transactional and
   * pipeline-stopping events are not toggleable, and the code enforces that by
   * having no preference to read for them rather than by checking a flag.
   */
  readonly toggleable: boolean
  /** The `notification_prefs` column that governs it, where one does. */
  readonly preference?: 'email_article_published' | 'email_digest_frequency'
  readonly dedupeKey: DedupeKeySource
}

const ROWS: readonly NotificationChannelRow[] = [
  {
    type: 'oauth_reminder',
    surface: 'dashboard_card',
    email: 'always',
    emailDefaultOn: true,
    toggleable: false,
    dedupeKey: { kind: 'sweep_threshold' },
  },
  {
    type: 'ingestion_review_ready',
    surface: 'bell',
    email: 'always',
    emailDefaultOn: true,
    toggleable: false,
    dedupeKey: { kind: 'ref', ref: 'ingestion_job_id' },
  },
  {
    // The activation moment: the first set of opportunities. Not toggleable —
    // a merchant who never hears this never starts using the product.
    type: 'opportunities_ready',
    surface: 'bell',
    email: 'always',
    emailDefaultOn: true,
    toggleable: false,
    dedupeKey: { kind: 'ref', ref: 'signal_run_id' },
  },
  {
    // Weekly. An email every week would be noise, so the bell carries it and
    // the monthly summary is where it reaches the inbox.
    type: 'new_opportunities_found',
    surface: 'bell',
    email: 'monthly_summary_only',
    emailDefaultOn: false,
    toggleable: false,
    dedupeKey: { kind: 'iso_week' },
  },
  {
    // The merchant asked for this one, so they are already looking at the app.
    type: 'optimize_recommendation_ready',
    surface: 'bell',
    email: 'none',
    emailDefaultOn: false,
    toggleable: false,
    dedupeKey: { kind: 'ref', ref: 'opportunity_id' },
  },
  {
    type: 'merchant_task_created',
    surface: 'attention_list',
    email: 'monthly_summary_only',
    emailDefaultOn: false,
    toggleable: false,
    dedupeKey: { kind: 'ref', ref: 'opportunity_id' },
  },
  {
    // Up to one a day, so a mail per article would read as spam.
    type: 'article_published',
    surface: 'bell',
    email: 'opt_in',
    emailDefaultOn: false,
    toggleable: true,
    preference: 'email_article_published',
    dedupeKey: { kind: 'ref', ref: 'article_id' },
  },
  {
    // Only exists at all when the merchant turned draft review on, and then it
    // is the thing blocking publication.
    type: 'draft_ready_for_review',
    surface: 'bell',
    email: 'always',
    emailDefaultOn: true,
    toggleable: false,
    dedupeKey: { kind: 'ref', ref: 'article_id' },
  },
  {
    // Held back rather than published badly. Emailing every one of these would
    // turn a quality decision into a stream of apparent failures.
    type: 'topic_held_by_gate',
    surface: 'calendar_card',
    email: 'monthly_summary_only',
    emailDefaultOn: false,
    toggleable: false,
    dedupeKey: { kind: 'ref', ref: 'topic_id' },
  },
  {
    type: 'monthly_summary_ready',
    surface: 'bell',
    email: 'always',
    emailDefaultOn: true,
    toggleable: true,
    preference: 'email_digest_frequency',
    dedupeKey: { kind: 'year_month' },
  },
  {
    type: 'repair_needed',
    surface: 'attention_list',
    email: 'always',
    emailDefaultOn: true,
    toggleable: false,
    dedupeKey: { kind: 'ref', ref: 'article_id' },
  },
  {
    type: 'connection_lost_shopify',
    surface: 'banner',
    email: 'always',
    emailDefaultOn: true,
    toggleable: false,
    dedupeKey: { kind: 'sweep_threshold' },
  },
  /**
   * Shopify refused a post and automatic posting was switched off. Treated like
   * a lost connection rather than like an article notice: publishing has
   * stopped and stays stopped until the merchant acts, so it is a banner they
   * meet on the way in, it is emailed, and it cannot be switched off — a
   * merchant who never opens the bell would otherwise find out weeks later that
   * nothing has gone out.
   *
   * Keyed on the article that was refused, so a shop refusing the same article
   * tomorrow rings once rather than every morning.
   */
  {
    type: 'auto_publish_paused',
    surface: 'banner',
    email: 'always',
    emailDefaultOn: true,
    toggleable: false,
    dedupeKey: { kind: 'ref', ref: 'article_id' },
  },
  {
    type: 'connection_lost_gsc',
    surface: 'banner',
    email: 'always',
    emailDefaultOn: true,
    toggleable: false,
    dedupeKey: { kind: 'sweep_threshold' },
  },
  {
    type: 'payment_failed',
    surface: 'banner',
    email: 'always',
    emailDefaultOn: true,
    toggleable: false,
    dedupeKey: { kind: 'sweep_threshold' },
  },
  {
    type: 'export_url_reminder',
    surface: 'attention_list',
    email: 'always',
    emailDefaultOn: true,
    toggleable: false,
    dedupeKey: { kind: 'ref', ref: 'article_id' },
  },
  {
    // Account-security mail (tech §1.5) — always sent, never toggleable, and
    // exempt from suppression (`EmailAudience.securityEmail`). The bell entry
    // is nominal: read access is revoked the moment deletion is requested
    // (DECISIONS 2026-09-02 T8.3), so nobody sees it there. The send record
    // itself does not go through `email_sends` — see `deletion_confirmation_emails`.
    type: 'account_deletion_confirmed',
    surface: 'bell',
    email: 'always',
    emailDefaultOn: true,
    toggleable: false,
    dedupeKey: { kind: 'ref', ref: 'deleted_at' },
  },
]

const BY_TYPE = new Map<NotificationType, NotificationChannelRow>(ROWS.map((row) => [row.type, row]))

export const NOTIFICATION_MATRIX: readonly NotificationChannelRow[] = ROWS

export function notificationChannels(type: NotificationType): NotificationChannelRow {
  const row = BY_TYPE.get(type)
  if (!row) {
    // Adding a type is a code change — enum, template, matrix row. Reaching
    // here means two of the three happened.
    throw new Error(`No channel matrix row for notification type "${type}".`)
  }
  return row
}

/** Every type has a row; the test holds this, and so does this call at startup. */
export function assertMatrixCoversEveryType(): void {
  for (const type of NOTIFICATION_TYPES) notificationChannels(type)
}
