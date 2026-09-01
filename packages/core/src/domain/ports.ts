/**
 * `packages/core` holds domain logic and owns no persistence (CLAUDE.md
 * code-structure rules), so the claim is expressed as a port here and bound to
 * Postgres in `apps/web`.
 */

// main §13 `domains.state`, via the frozen contract's `domainStateSchema` — one
// definition, so a state added to the API can never disagree with the claim.
export type { DomainState } from '../account/view'
import type { DomainState } from '../account/view'

export type StoreClaimResult =
  /** The insert won. The ingestion run was created in the same transaction. */
  | { readonly kind: 'claimed'; readonly state: DomainState; readonly ingestionJobId: string }
  /** main §5 — "Claimed by this account → no-op / redirect to dashboard." */
  | { readonly kind: 'already_yours'; readonly state: DomainState; readonly ingestionJobId: string }
  /** main §5 — "Already claimed by another account → error." */
  | { readonly kind: 'taken_by_other' }
  /** Invariant 1 — one domain per account. `current` is the one it already holds. */
  | { readonly kind: 'account_has_other_domain'; readonly current: string }

export interface ClaimRequest {
  readonly accountId: string
  /** Already eTLD+1-normalised (main §2). The store writes what it is given. */
  readonly normalized: string
  /**
   * main §14.3.2 — derived from inputs, never random, so a retried claim
   * reuses one ingestion run instead of starting a second.
   */
  readonly runId: string
}

export interface DomainClaimStore {
  /**
   * main §5 step 2 — "Claim is written **transactionally** with the uniqueness
   * check (insert with unique index, catch conflict) — no TOCTOU race between
   * two signups claiming the same domain simultaneously." Invariant 1.
   *
   * Three obligations on any implementation:
   *
   * 1. The insert is `ON CONFLICT DO NOTHING`; nothing may read the table to
   *    decide whether to insert. The unique index picks the winner.
   * 2. Which conflict it was is discovered by reading the conflicting row back
   *    **inside the same transaction**, so the answer cannot be stale.
   * 3. Step 3 of main §5 — "Claiming enqueues the deep ingestion job" — commits
   *    with the claim. A claim that committed without its run would leave the
   *    merchant on a progress screen nothing will ever advance, and no code
   *    path re-checks.
   */
  claimWithIngestionRun(request: ClaimRequest): Promise<StoreClaimResult>
}
