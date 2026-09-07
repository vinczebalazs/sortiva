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

/**
 * Every setting the Settings screens show, in one read.
 *
 * Deliberately separate from `readAccountSettings` rather than widening it: that
 * one is what the generation cycle and the publishing sweep ask for, several
 * times a night per account, and they want five columns rather than a join.
 * This one runs once when a merchant opens a screen.
 *
 * The two email preferences live in their own table because only the opt-in
 * notifications are toggleable — the transactional ones have no column to read,
 * which is how that rule is enforced.
 */
export interface SettingsScreenRow {
  readonly publishHour: number
  readonly timezone: string
  readonly draftReview: boolean
  readonly autoRepair: boolean
  readonly delivery: (typeof accountSettings.delivery)['_']['data']
  readonly shopifyPublishAs: (typeof accountSettings.shopifyPublishAs)['_']['data']
  readonly vacationMode: boolean
  readonly uiLanguage: string | null
}

const SCREEN_DEFAULTS: SettingsScreenRow = {
  publishHour: 9,
  timezone: 'UTC',
  draftReview: false,
  autoRepair: true,
  delivery: 'export',
  shopifyPublishAs: 'live',
  vacationMode: false,
  uiLanguage: null,
}

export async function readSettingsScreen(
  db: Db,
  scope: AccountScope,
): Promise<SettingsScreenRow> {
  const [row] = await db
    .select({
      publishHour: accountSettings.publishHour,
      timezone: accountSettings.timezone,
      draftReview: accountSettings.draftReview,
      autoRepair: accountSettings.autoRepair,
      delivery: accountSettings.delivery,
      shopifyPublishAs: accountSettings.shopifyPublishAs,
      vacationMode: accountSettings.vacationMode,
      uiLanguage: accountSettings.uiLanguage,
    })
    .from(accountSettings)
    .where(eq(accountSettings.accountId, scope.accountId))
    .limit(1)
  return row ?? SCREEN_DEFAULTS
}

/**
 * Writes the settings a merchant changed, and only those.
 *
 * `delivery` is absent on purpose. Switching to auto-publish is the one setting
 * with a condition attached — a write grant and a resolved target blog — and it
 * goes through `setDeliveryMode`, which carries that condition in its own
 * `WHERE` clause. Accepting it here would be a second way in that does not.
 */
export async function saveSettingsScreen(
  db: Db,
  scope: AccountScope,
  patch: Partial<Omit<SettingsScreenRow, 'delivery'>>,
  now: Date = new Date(),
): Promise<void> {
  if (Object.keys(patch).length === 0) return
  await db
    .insert(accountSettings)
    .values({ accountId: scope.accountId, ...patch })
    .onConflictDoUpdate({
      target: accountSettings.accountId,
      set: { ...patch, updatedAt: now },
    })
}
