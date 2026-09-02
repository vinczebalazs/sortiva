import {
  accountAttribution,
  registerStub,
  type Logger,
  type NotificationEmitter,
} from '@sortiva/core'
import type { Db } from '@sortiva/db'
import { runtimeLogger } from '../runtime/logging'
import { registerTask } from '../runtime/tasks'

/**
 * A merchant who downloaded an article and never told us where it went hears
 * from us once, a week later.
 *
 * We are not nagging: without the published address we cannot measure whether
 * the article did anything, so their own reporting is the thing that stays
 * blank. It is a sweep rather than a message scheduled per article because
 * there is nothing to cancel — an article whose address arrives simply stops
 * matching.
 */

export const EXPORT_URL_REMINDER_SWEEP_TASK = 'export_url_reminder_sweep'

/**
 * How long an exported article may sit with no known address before we ask.
 * Long enough that a merchant who publishes on a weekly rhythm is not chased
 * mid-cycle.
 */
export const REMINDER_AFTER_DAYS = 7

/**
 * Exported articles live in the `articles` table, which schema wave 3 creates.
 * Until then this sweep can find nothing, and it says so rather than reporting
 * a clean zero — a reminder job that cannot see articles looks exactly like a
 * product where everyone confirms their URLs.
 *
 * Registered but not captured per call: `stub_used` needs an account to
 * attribute the event to, and a sweep that found nothing has none. The registry
 * is what `pnpm stubs:report` reads, and that is what makes the gap visible.
 */
export const EXPORT_REMINDER_STUB = 'ExportUrlReminder.articles'

registerStub({
  contract: EXPORT_REMINDER_STUB,
  filledBy: 'D — T4.0 (schema wave 3: articles and their published addresses)',
  behaviour: 'the sweep finds no exported articles, so no reminder is ever sent',
  mustBeGoneBy: 'M4',
})

export interface ExportUrlReminderDeps {
  readonly getDb: () => Db
  readonly notifications: NotificationEmitter
  readonly logger?: Logger
  readonly now?: () => Date
}

/** What the sweep needs to read. Filled by the lane that owns `articles`. */
export interface UnconfirmedExport {
  readonly accountId: string
  readonly articleId: string
}

export type UnconfirmedExportSource = (cutoff: Date) => Promise<readonly UnconfirmedExport[]>

export interface ExportUrlReminderResult {
  readonly considered: number
  readonly notified: number
}

export async function sweepExportUrlReminders(
  deps: ExportUrlReminderDeps,
  source?: UnconfirmedExportSource,
): Promise<ExportUrlReminderResult> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const cutoff = new Date(now.getTime() - REMINDER_AFTER_DAYS * 24 * 60 * 60 * 1000)

  // No source until `articles` exists, which is the registered stub above.
  const pending: readonly UnconfirmedExport[] = source ? await source(cutoff) : []

  let notified = 0
  for (const item of pending) {
    // Keyed on the article, so running this every hour sends once: every run
    // after the first attempts an insert the unique triple refuses.
    const emitted = await deps.notifications.emit(
      'export_url_reminder',
      { article_id: item.articleId },
      item.articleId,
      accountAttribution(item.accountId),
    )
    if (emitted.created) notified += 1
  }

  log.info('export_url_reminder_sweep.completed', { considered: pending.length, notified })
  return { considered: pending.length, notified }
}

let registered = false

export function registerExportUrlReminderTask(
  deps: ExportUrlReminderDeps,
  source?: UnconfirmedExportSource,
): void {
  if (registered) return
  registered = true
  registerTask(EXPORT_URL_REMINDER_SWEEP_TASK, async () => {
    await sweepExportUrlReminders(deps, source)
  })
}

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetExportUrlReminderRegistration(): void {
  registered = false
}
