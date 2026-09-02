import type { NotificationType } from '../contracts/opportunities'
import { NOTIFICATION_MATRIX, notificationChannels } from '../notifications/matrix'

/**
 * One domain event reaches up to two places: the bell, always, and the inbox,
 * sometimes. This decides the second half — and it is the *only* place that
 * decides it, so a lane emitting a new event never has to know whether its
 * event is emailed.
 *
 * Three things can stop an email, and they are deliberately different:
 *
 *  - the **kind of event** never emails (a recommendation the merchant asked
 *    for, or one of the three kinds the monthly summary carries instead);
 *  - the **merchant** turned that kind off, which is only possible for the
 *    kinds that have a preference to read;
 *  - the **address** is suppressed, because mail to it bounced or was reported
 *    as spam. That last one still writes a row, marked as stopped, so a
 *    merchant asking "why did I not get that" has an answer.
 */

/** The preference row, or its absence — which is not the same thing. */
export interface NotificationPreferences {
  readonly emailArticlePublished: boolean
  readonly emailDigestFrequency: 'off' | 'daily' | 'weekly'
}

export interface EmailAudience {
  /** The address has bounced or complained; see `email_suppressions`. */
  readonly suppressed: boolean
  /**
   * Undefined when the merchant has never saved a notification setting, which
   * is what makes the matrix's default-on column mean something. It is not the
   * same as a saved row whose values happen to equal the defaults: one is "has
   * not chosen", the other is "chose this".
   */
  readonly preferences?: NotificationPreferences
  /**
   * Account-security mail — a deletion confirmation — goes out even to a
   * suppressed address, because someone is entitled to be told their account is
   * gone whether or not their mail server likes us.
   */
  readonly securityEmail?: boolean
}

export type EmailSkipReason =
  /** The event has no email at all: the merchant is already looking at the app. */
  | 'never_emailed'
  /** No email of its own — it is one line in the monthly summary. */
  | 'carried_by_monthly_summary'
  /** The merchant turned this kind off. */
  | 'turned_off'

export type EmailFanOut =
  | { readonly send: true; readonly state: 'queued' }
  /** Recorded and never sent: the address is suppressed. */
  | { readonly send: true; readonly state: 'suppressed' }
  | { readonly send: false; readonly reason: EmailSkipReason }

/**
 * Whether the merchant wants this kind of mail.
 *
 * A type with no preference column is not toggleable — connection lost, payment
 * failed, a draft blocking publication — and that is enforced by there being
 * nothing to read rather than by a flag somebody could set wrongly.
 */
export function emailWanted(type: NotificationType, audience: EmailAudience): boolean {
  const row = notificationChannels(type)
  if (!row.preference) return true
  const prefs = audience.preferences
  if (!prefs) return row.emailDefaultOn
  switch (row.preference) {
    case 'email_article_published':
      return prefs.emailArticlePublished
    case 'email_digest_frequency':
      // `off` is what one-click unsubscribe writes. Any cadence, and the
      // absence of a saved row, mean send. See DECISIONS 2026-09-02: this one
      // column carries both the monthly summary and the per-article digest,
      // because tech §1.3 gives `notification_prefs` no third column.
      return prefs.emailDigestFrequency !== 'off'
  }
}

export function emailFanOut(type: NotificationType, audience: EmailAudience): EmailFanOut {
  const row = notificationChannels(type)

  if (row.email === 'none') return { send: false, reason: 'never_emailed' }
  if (row.email === 'monthly_summary_only') {
    return { send: false, reason: 'carried_by_monthly_summary' }
  }
  if (!emailWanted(type, audience)) return { send: false, reason: 'turned_off' }

  if (audience.suppressed && !audience.securityEmail) {
    return { send: true, state: 'suppressed' }
  }
  return { send: true, state: 'queued' }
}

/**
 * The kinds the monthly summary has to account for, because they reach the
 * inbox nowhere else. Read from the matrix rather than listed again here, so
 * moving a row to its own email cannot leave the summary silently reporting
 * something twice.
 */
export const CARRIED_BY_MONTHLY_SUMMARY: readonly NotificationType[] = NOTIFICATION_MATRIX.filter(
  (row) => row.email === 'monthly_summary_only',
).map((row) => row.type)

/**
 * What a merchant who has never opened Settings gets. Used when a preference
 * row is first written, so saving one setting cannot silently change another:
 * the writer states every column, and these are the values it states for the
 * ones the merchant did not touch.
 */
export function defaultNotificationPreferences(): NotificationPreferences {
  return {
    emailArticlePublished: notificationChannels('article_published').emailDefaultOn,
    // Default-on for the monthly summary, and the article digest is a separate
    // switch, so the cadence only has to be "not off".
    emailDigestFrequency: notificationChannels('monthly_summary_ready').emailDefaultOn
      ? 'weekly'
      : 'off',
  }
}

/**
 * Non-transactional mail must carry a one-click unsubscribe (Gmail and Yahoo
 * bulk-sender rules), and it is the toggleable kinds that are non-transactional.
 * A connection-lost email has no unsubscribe because switching it off would
 * leave the merchant's pipeline stopped with nobody told.
 */
export function needsUnsubscribe(type: NotificationType): boolean {
  return notificationChannels(type).toggleable
}
