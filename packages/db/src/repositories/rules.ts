import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { rulesOverrides } from '../schema'
import type { AccountScope, SystemScope } from '../scope'

/**
 * `rules_overrides` is the layer above `signals.config.yaml`: a row moves one
 * threshold for one store, one language or one page type, without a deploy.
 * `packages/rules` folds the rows; this file only fetches and writes them.
 *
 * Rows with no `account_id` are global by design — that is what makes this one
 * of the tables reachable under `SystemScope` (see `scope.ts`). So the read a
 * store's scan makes takes an `AccountScope` and returns that store's rows
 * **plus** the account-less ones; the account-less half belongs to nobody, and
 * the scoped half cannot reach another store's rows. Operator writes, which can
 * aim at every store at once, take a `SystemScope`.
 */

export type RulesOverrideRecord = typeof rulesOverrides.$inferSelect

/** Which rows a set or a clear is aimed at. Every unset field means "the rows that name none". */
export interface RulesOverrideTarget {
  accountId?: string | null
  locale?: string | null
  pageType?: string | null
}

/**
 * `IS NOT DISTINCT FROM` rather than `=`, because three of the four columns
 * that identify a row are nullable and a null never equals anything — so `=`
 * would silently match no rows when clearing a global override.
 */
function aimedExactlyAt(target: RulesOverrideTarget) {
  return and(
    sql`${rulesOverrides.accountId} is not distinct from ${target.accountId ?? null}::uuid`,
    sql`${rulesOverrides.locale} is not distinct from ${target.locale ?? null}`,
    sql`${rulesOverrides.pageType} is not distinct from ${target.pageType ?? null}`,
  )
}

/**
 * Every row that could apply to this store: its own, and the ones aimed at no
 * store in particular. `locale` and `pageType` are matched **exactly** against
 * what the caller passes — a row for "da" does not reach a store recorded as
 * "da-DK", unlike the locale layers in the config file, which resolve a full
 * tag through its language subtag.
 *
 * Read fresh on every call. There is no cache: an override takes effect on the
 * store's next scan rather than after some invalidation window, and the cost is
 * one indexed lookup per scan, against a table that holds a handful of rows.
 */
export async function readRulesOverridesForAccount(
  db: Db,
  scope: AccountScope,
  filter: { locale?: string | null; pageType?: string | null } = {},
): Promise<RulesOverrideRecord[]> {
  const locale = filter.locale ?? null
  const pageType = filter.pageType ?? null
  return db
    .select()
    .from(rulesOverrides)
    .where(
      and(
        or(isNull(rulesOverrides.accountId), eq(rulesOverrides.accountId, scope.accountId)),
        locale === null
          ? isNull(rulesOverrides.locale)
          : or(isNull(rulesOverrides.locale), eq(rulesOverrides.locale, locale)),
        pageType === null
          ? isNull(rulesOverrides.pageType)
          : or(isNull(rulesOverrides.pageType), eq(rulesOverrides.pageType, pageType)),
      ),
    )
    .orderBy(asc(rulesOverrides.key), asc(rulesOverrides.updatedAt))
}

/** Everything an operator has set, newest last. `accountId` narrows to one store's rows and the global ones. */
export async function listRulesOverrides(
  db: Db,
  _scope: SystemScope,
  filter: { accountId?: string } = {},
): Promise<RulesOverrideRecord[]> {
  const query = db.select().from(rulesOverrides)
  const rows = filter.accountId
    ? await query
        .where(or(isNull(rulesOverrides.accountId), eq(rulesOverrides.accountId, filter.accountId)))
        .orderBy(asc(rulesOverrides.key), asc(rulesOverrides.updatedAt))
    : await query.orderBy(asc(rulesOverrides.key), asc(rulesOverrides.updatedAt))
  return rows
}

/**
 * Sets one threshold for one aim, replacing whatever was there.
 *
 * Delete-then-insert inside a transaction rather than `ON CONFLICT`: there is
 * no unique index on `(account_id, locale, page_type, key)` and adding one
 * needs a migration, which only a schema-wave card may write. The transaction
 * is what stops a crash between the two leaving the store with no override at
 * all; two operators setting the same threshold at the same moment still leave
 * exactly one row, because the delete takes the lock.
 */
export async function setRulesOverride(
  db: Db,
  _scope: SystemScope,
  input: RulesOverrideTarget & { key: string; value: unknown; updatedBy: string },
): Promise<RulesOverrideRecord> {
  return db.transaction(async (tx) => {
    await tx
      .delete(rulesOverrides)
      .where(and(aimedExactlyAt(input), eq(rulesOverrides.key, input.key)))
    const [written] = await tx
      .insert(rulesOverrides)
      .values({
        accountId: input.accountId ?? null,
        locale: input.locale ?? null,
        pageType: input.pageType ?? null,
        key: input.key,
        value: input.value,
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      })
      .returning()
    if (!written) throw new Error(`rules_overrides insert returned no row for ${input.key}`)
    return written
  })
}

/** Removes one threshold's override at one aim. Returns what was removed, so a clear that hit nothing can say so. */
export async function clearRulesOverride(
  db: Db,
  _scope: SystemScope,
  target: RulesOverrideTarget & { key: string },
): Promise<RulesOverrideRecord[]> {
  return db
    .delete(rulesOverrides)
    .where(and(aimedExactlyAt(target), eq(rulesOverrides.key, target.key)))
    .returning()
}
