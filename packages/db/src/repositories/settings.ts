import { eq, isNull } from 'drizzle-orm'
import type { Db } from '../client'
import { accountSettings, accounts } from '../schema'
import type { AccountScope, SystemScope } from '../scope'

/**
 * What the Settings screens hold, read back by the jobs that have to honour it.
 *
 * An account with no settings row has never changed anything, so every answer
 * is the column default rather than an absence the caller has to handle: no
 * draft review, export delivery, 09:00, UTC.
 */

export interface AccountSettingsRow {
  /** The hour an article is due out, on the store's own clock. */
  readonly publishHour: number
  /** IANA zone name — the persona country's, defaulted during onboarding. */
  readonly timezone: string
  /** When on, a passing draft waits for the merchant instead of going out. Main §9.3. */
  readonly draftReview: boolean
  readonly delivery: (typeof accountSettings.delivery)['_']['data']
  readonly vacationMode: boolean
}

const DEFAULTS: AccountSettingsRow = {
  publishHour: 9,
  timezone: 'UTC',
  draftReview: false,
  delivery: 'export',
  vacationMode: false,
}

export async function readAccountSettings(
  db: Db,
  scope: AccountScope,
): Promise<AccountSettingsRow> {
  const [row] = await db
    .select({
      publishHour: accountSettings.publishHour,
      timezone: accountSettings.timezone,
      draftReview: accountSettings.draftReview,
      delivery: accountSettings.delivery,
      vacationMode: accountSettings.vacationMode,
    })
    .from(accountSettings)
    .where(eq(accountSettings.accountId, scope.accountId))
    .limit(1)
  return row ?? DEFAULTS
}

export interface AccountClockRow {
  readonly accountId: string
  readonly timezone: string
  readonly publishHour: number
}

/**
 * Every live account with the two facts that decide *when* its day runs.
 *
 * Deliberately unscoped: a sweep's whole job is to look across every account.
 * It reads no merchant state beyond the clock — whether the account may
 * actually generate is asked per account, later, where the answer can be
 * logged against that account.
 */
export async function accountClocks(
  db: Db,
  _scope: SystemScope,
): Promise<readonly AccountClockRow[]> {
  const rows = await db
    .select({
      accountId: accounts.id,
      timezone: accountSettings.timezone,
      publishHour: accountSettings.publishHour,
    })
    .from(accounts)
    .leftJoin(accountSettings, eq(accountSettings.accountId, accounts.id))
    .where(isNull(accounts.deletedAt))
  return rows.map((row) => ({
    accountId: row.accountId,
    timezone: row.timezone ?? DEFAULTS.timezone,
    publishHour: row.publishHour ?? DEFAULTS.publishHour,
  }))
}
