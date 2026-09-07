/**
 * `packages/core` holds domain logic and owns no persistence (CLAUDE.md
 * code-structure rules), so the claim is expressed as a port here and bound to
 * Postgres in `apps/web`.
 */

// Re-exported from the frozen contract rather than redeclared, so a state added
// to the API can never disagree with what the claim understands.
export type { DomainState } from '../account/view'
import type { DomainState } from '../account/view'

export type StoreClaimResult =
  /** The insert won. The ingestion run was created in the same transaction. */
  | { readonly kind: 'claimed'; readonly state: DomainState; readonly ingestionJobId: string }
  /** Already this account's domain: a no-op, and the caller redirects to the dashboard. */
  | { readonly kind: 'already_yours'; readonly state: DomainState; readonly ingestionJobId: string }
  /** Someone else holds it. Transfers are support-mediated; there is no self-serve path. */
  | { readonly kind: 'taken_by_other' }
  /** Invariant 1 — one domain per account. `current` is the one it already holds. */
  | { readonly kind: 'account_has_other_domain'; readonly current: string }

export interface ClaimRequest {
  readonly accountId: string
  /** Already normalised to the registrable domain. The store writes what it is given. */
  readonly normalized: string
  /**
   * Derived from the inputs, never random, so a retried claim
   * reuses one ingestion run instead of starting a second.
   */
  readonly runId: string
}

export interface DomainClaimStore {
  /**
   * The claim is an insert against a unique index whose conflict is caught —
   * never a check followed by an insert, which would let two signups racing for
   * the same domain both pass the check.
   *
   * Three obligations on any implementation:
   *
   * 1. The insert is `ON CONFLICT DO NOTHING`; nothing may read the table to
   *    decide whether to insert. The unique index picks the winner.
   * 2. Which conflict it was is discovered by reading the conflicting row back
   *    **inside the same transaction**, so the answer cannot be stale.
   * 3. The ingestion job is enqueued in the same commit as the claim. A claim
   *    that committed without its run would leave the
   *    merchant on a progress screen nothing will ever advance, and no code
   *    path re-checks.
   * 4. A row left behind by a deleted account carries the date its hold on the
   *    domain ends. Once that date has passed the row no longer blocks anyone,
   *    and the claim must act on it itself instead of waiting for the nightly
   *    clean-up to remove it — otherwise a clean-up that never runs holds the
   *    domain for ever. Doing this must not turn the claim into a read that
   *    decides whether to insert; obligation 1 still stands.
   */
  claimWithIngestionRun(request: ClaimRequest): Promise<StoreClaimResult>
}
