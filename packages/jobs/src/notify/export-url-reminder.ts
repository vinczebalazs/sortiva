import { accountAttribution, type Logger, type NotificationEmitter } from '@sortiva/core'
import {
  systemScope,
  unconfirmedExportedArticlesAcrossAccounts,
  type Db,
} from '@sortiva/db'
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

export interface ExportUrlReminderDeps {
  readonly getDb: () => Db
  readonly notifications: NotificationEmitter
  readonly logger?: Logger
  readonly now?: () => Date
}

/** One article this sweep may ask about. */
export interface UnconfirmedExport {
  readonly accountId: string
  readonly articleId: string
}

export type UnconfirmedExportSource = (cutoff: Date) => Promise<readonly UnconfirmedExport[]>

/**
 * The real source: every account's exported-but-unconfirmed articles in one
 * query.
 *
 * It reads across accounts rather than one at a time, and says why in the
 * scope it asks for — a sweep that went account by account would have to walk
 * every store on the platform hourly to find the handful with anything
 * waiting. Every row it returns names its own account, so the notification it
 * produces is attributed to the right one.
 */
export function dbUnconfirmedExports(getDb: () => Db): UnconfirmedExportSource {
  return async (cutoff) => {
    const rows = await unconfirmedExportedArticlesAcrossAccounts(
      getDb(),
      systemScope(
        'the export-URL reminder sweep looks across every account for articles published with no address',
      ),
      cutoff,
    )
    return rows.map((row) => ({ accountId: row.accountId, articleId: row.articleId }))
  }
}

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

  const read = source ?? dbUnconfirmedExports(deps.getDb)
  const pending = await read(cutoff)

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
  source: UnconfirmedExportSource = dbUnconfirmedExports(deps.getDb),
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
