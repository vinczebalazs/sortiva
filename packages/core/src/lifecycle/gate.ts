import type { BillingGate } from '../billing/entitlement'

/**
 * What an account is allowed to do right now, once three separate reasons to
 * stop have been considered together.
 *
 * The three are deliberately different in what they stop:
 *
 * - **Billing.** Not paid up: generation and publishing stop, everything else
 *   continues, and read access is never taken away.
 * - **Vacation mode.** The merchant is away: topic generation and publishing
 *   stop, while the store keeps being read and Search Console keeps reporting —
 *   so they come back to current data rather than a month-shaped hole. Without
 *   this toggle, a merchant going away revokes our tokens instead, which loses
 *   the history.
 * - **Deletion requested.** The account is on its way out; nothing runs.
 *
 * One function rather than three checks at each call site, because "does
 * vacation mode stop the nightly catalogue walk" is a product answer and it
 * should have exactly one place to live.
 */

export type StopReason = 'deletion_requested' | 'billing' | 'vacation'

export interface LifecycleStateInput {
  /** The billing verdict for this account, from `billingGate`. */
  readonly billing: BillingGate
  /** `account_settings.vacation_mode`. */
  readonly vacationMode: boolean
  /** `accounts.deleted_at`. Set the moment deletion is requested. */
  readonly deletionRequestedAt: Date | null
}

export interface LifecycleGate {
  /** New topics and article drafts. */
  readonly generationAllowed: boolean
  /** Publishing to the store, and exporting. */
  readonly publishingAllowed: boolean
  /** The nightly catalogue walk and the webhook drain. */
  readonly catalogSyncAllowed: boolean
  /** The daily Search Console pull. */
  readonly searchReportingAllowed: boolean
  /**
   * Reading what we already made. Billing never takes this away (invariant 16);
   * a requested deletion does, because the account is being erased.
   */
  readonly readAllowed: boolean
  /**
   * Every reason that is currently stopping something, most serious first, so a
   * screen can say "paused for two reasons" rather than picking one and being
   * wrong when the merchant fixes it.
   */
  readonly stoppedBy: readonly StopReason[]
}

export function lifecycleGate(state: LifecycleStateInput): LifecycleGate {
  const deleting = state.deletionRequestedAt !== null
  const billingStops = !state.billing.generationAllowed
  const vacation = state.vacationMode

  const stoppedBy: StopReason[] = []
  if (deleting) stoppedBy.push('deletion_requested')
  if (billingStops) stoppedBy.push('billing')
  if (vacation) stoppedBy.push('vacation')

  return {
    generationAllowed: !deleting && !billingStops && !vacation,
    publishingAllowed: !deleting && state.billing.publishingAllowed && !vacation,
    // Vacation mode keeps these two alive on purpose. Deletion stops them
    // because the tokens they need are revoked the moment it is requested.
    catalogSyncAllowed: !deleting,
    searchReportingAllowed: !deleting,
    readAllowed: !deleting,
    stoppedBy,
  }
}
