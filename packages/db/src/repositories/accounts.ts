import { and, eq, isNull, or } from 'drizzle-orm'
import type { Db } from '../client'
import { accounts, opsFlags, shopifyConns, subscriptions } from '../schema'
import type { AccountScope, SystemScope } from '../scope'

export type AccountRow = typeof accounts.$inferSelect
export type SubscriptionRow = typeof subscriptions.$inferSelect
export type ShopifyConnRow = typeof shopifyConns.$inferSelect

/**
 * main §4.1 — "an account is created with `domain = null`". There is no
 * `domains` row until the claim in main §5, so `domain = null` is the absence
 * of that row rather than a nullable column.
 *
 * Signup runs before any account exists, so it cannot carry an `AccountScope`;
 * it takes a `SystemScope` with a written reason, per the T0.3 convention.
 */
export async function findAccountByEmail(
  db: Db,
  _scope: SystemScope,
  email: string,
): Promise<AccountRow | undefined> {
  const [row] = await db.select().from(accounts).where(eq(accounts.email, email)).limit(1)
  return row
}

/**
 * main §5's pattern applied to identity: insert-with-conflict, never
 * check-then-insert. Two sign-in callbacks for one email arriving together
 * cannot both create — the unique index on `accounts.email` decides, and the
 * loser reads the winner's row.
 *
 * `created` is what tells the caller whether this is a signup (main §14.7's
 * `signup_completed`) or a returning user.
 */
export async function createOrFindAccountByEmail(
  db: Db,
  scope: SystemScope,
  email: string,
): Promise<{ account: AccountRow; created: boolean }> {
  const [inserted] = await db.insert(accounts).values({ email }).onConflictDoNothing().returning()
  if (inserted) return { account: inserted, created: true }

  const existing = await findAccountByEmail(db, scope, email)
  if (!existing) {
    // Only reachable if the row vanished between the conflict and the read.
    throw new Error('account insert conflicted but no row could be read back')
  }
  return { account: existing, created: false }
}

export async function findAccountById(
  db: Db,
  scope: AccountScope,
): Promise<AccountRow | undefined> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, scope.accountId)).limit(1)
  return row
}

/**
 * main §4.2, invariant 16 — entitlement is the local row and nothing else. This
 * is a read; the Stripe webhook worker (T1.2) is the only writer.
 */
export async function findSubscriptionForAccount(
  db: Db,
  scope: AccountScope,
): Promise<SubscriptionRow | undefined> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.accountId, scope.accountId))
    .limit(1)
  return row
}

/** main §6.2 — granted scopes and `invalidated_at` are what the UI's connection state is derived from. */
export async function findShopifyConnForAccount(
  db: Db,
  scope: AccountScope,
): Promise<ShopifyConnRow | undefined> {
  const [row] = await db
    .select()
    .from(shopifyConns)
    .where(eq(shopifyConns.accountId, scope.accountId))
    .limit(1)
  return row
}

/**
 * main §14.5 — the flags currently tripped that bear on this account: the
 * global ones (which apply to everybody) and this account's own. Returned as
 * `scope.flag` names so the policy decision — which flags mean "paused" to the
 * user — stays in `packages/core` rather than in a query.
 */
export async function activeOpsFlagsForAccount(
  db: Db,
  scope: AccountScope,
): Promise<string[]> {
  const rows = await db
    .select({ scope: opsFlags.scope, flag: opsFlags.flag })
    .from(opsFlags)
    .where(
      and(
        isNull(opsFlags.resetAt),
        or(eq(opsFlags.scope, 'global'), eq(opsFlags.accountId, scope.accountId)),
      ),
    )
  return rows.map((r) => `${r.scope}.${r.flag}`)
}
