/**
 * CLAUDE.md code-structure rules: "Every repository method requires an
 * `accountId` scope parameter; there is no unscoped table access outside
 * migrations and admin scripts."
 *
 * A plain `accountId: string` parameter satisfies that on paper and nothing in
 * practice — any string type-checks, including one read from a request body,
 * which tech §3 explicitly forbids ("Every authenticated route resolves
 * `account_id` from session — never from the request body"). So scope is a
 * branded type that only `accountScope()` can produce, and every repository
 * method takes it as its first argument. Omitting it is a compile error; see
 * `scope.test-d.ts`.
 */

declare const accountScopeBrand: unique symbol
declare const systemScopeBrand: unique symbol

export interface AccountScope {
  readonly [accountScopeBrand]: true
  readonly accountId: string
}

/**
 * The five wave-1 tables that genuinely have no `account_id` — `stripe_events`,
 * `webhook_events`, `request_cache`, `preview_cache`, `email_suppressions`.
 * Each is written before an account is known (a webhook is HMAC-verified and
 * stored before it is routed; a preview happens pre-signup; the request cache
 * is keyed by canonical params, not by tenant).
 *
 * Rather than let those repositories take no scope at all — which would make
 * "unscoped table access" a thing that exists and can spread — they take a
 * `SystemScope` carrying a written reason. The rule stays "no repository
 * method without a scope"; system access is explicit and greppable.
 * See DECISIONS 2026-08-27 T0.3.
 *
 * Schema wave 2 (T2.0) adds three more, for the same kind of reason:
 * `serp_snapshots` is keyed by canonical request parameters so two accounts
 * asking the same question in the same locale don't pay DataForSEO twice
 * (main §12.1); `rules_overrides` holds global and per-locale rows whose
 * `account_id` is null by design (main §7.10); and `spend_events` records
 * preview spend, which happens before any account exists (main §14.7). Their
 * repositories are not written yet — the cards that need them will take
 * `SystemScope` where the row has no account, and `AccountScope` otherwise.
 * See DECISIONS 2026-08-31 T2.0.
 *
 * Mini-wave 2b (T2.0b) adds two more. `verification_tokens` holds outstanding
 * email sign-in links, which exist before the account does (main §4.1).
 * `idempotency_ledger` is keyed on a hash and deliberately carries no account
 * column at all — an account cascade must not be able to erase the record that
 * paid work was already done (main §14.3.2, `docs/audits/T0.4.md`). Both take
 * `SystemScope`. See DECISIONS 2026-08-31 T2.0b.
 */
export interface SystemScope {
  readonly [systemScopeBrand]: true
  readonly reason: string
}

export function accountScope(accountId: string): AccountScope {
  if (!accountId) throw new Error('accountScope() requires an account id')
  return { accountId } as AccountScope
}

/** @param reason why this access has no account — recorded so review can judge it. */
export function systemScope(reason: string): SystemScope {
  if (!reason) throw new Error('systemScope() requires a reason')
  return { reason } as SystemScope
}
