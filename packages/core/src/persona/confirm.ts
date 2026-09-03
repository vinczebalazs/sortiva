import { accountAttribution, type PosthogCapture } from '../contracts/analytics'
import type { DomainState } from '../account/view'

/**
 * "Confirm profile" — the one action that ends onboarding (main §6.8) and the
 * activation-funnel step the acquisition dashboard is drawn from (main §14.7,
 * `preview → signup → checkout → domain → oauth → profile_confirmed`).
 *
 * Everything on the review screen is editable before this moment; nothing the
 * merchant typed is kept unless this succeeds. That is why the edits are
 * written only *after* the guarded transition wins its race — a losing request
 * (a double-click, a retried one) must not overwrite what the winning request,
 * or a later edit made from Settings, already wrote.
 */

export const PROFILE_CONFIRMED_EVENT = 'profile_confirmed'

export interface ProfileEdits {
  readonly description: string
  readonly language: string
  readonly country: string
  readonly audience: string
  readonly tone: string
  /**
   * The best-seller list's final order, ids only. An id the store no longer
   * holds is dropped rather than rejected; a removed row simply stops
   * appearing here, which is what "× to remove" means (ui §3.7 item 2).
   */
  readonly topProductIds: readonly string[]
}

export interface ConfirmProfileStore {
  /**
   * `UPDATE … WHERE state = expected`. Undefined means someone else moved the
   * store first — already confirmed, or a race lost to a concurrent click.
   */
  transition(
    accountId: string,
    from: readonly DomainState[],
    to: DomainState,
  ): Promise<DomainState | undefined>
  domainState(accountId: string): Promise<DomainState | undefined>
  /**
   * The business-profile fields, the top-product order, and — because this is
   * the merchant's decision on the keyword list `T3.3` reads as
   * `keywords.confirmed` — every keyword the account currently holds. One
   * write, so a crash between them cannot confirm the keywords a merchant
   * never saw the final description beside.
   */
  writeEdits(accountId: string, edits: ProfileEdits, now: Date): Promise<void>
}

export interface ConfirmProfileDeps {
  readonly store: ConfirmProfileStore
  /** Funnel capture. Optional so the domain logic runs without telemetry. */
  readonly capture?: Pick<PosthogCapture, 'capture'>
}

export type ConfirmProfileResult =
  | { readonly kind: 'confirmed' }
  /** The screen is already gone — this account confirmed already. */
  | { readonly kind: 'already_confirmed' }
  /** Ingestion has not reached the review step yet; there is nothing to confirm. */
  | { readonly kind: 'not_ready' }

export async function confirmProfile(
  deps: ConfirmProfileDeps,
  input: { accountId: string; domain: string; edits: ProfileEdits; now?: Date },
): Promise<ConfirmProfileResult> {
  const now = input.now ?? new Date()

  const moved = await deps.store.transition(
    input.accountId,
    ['needs_confirmation'],
    'ready_for_planning',
  )

  if (!moved) {
    const state = await deps.store.domainState(input.accountId)
    return { kind: state === 'ready_for_planning' ? 'already_confirmed' : 'not_ready' }
  }

  await deps.store.writeEdits(input.accountId, input.edits, now)

  // The onboarding opportunity run (main §6.9) is a later card's job to start;
  // this only carries the account past the gate it waits behind.
  deps.capture?.capture({
    event: PROFILE_CONFIRMED_EVENT,
    attribution: accountAttribution(input.accountId, input.domain),
  })

  return { kind: 'confirmed' }
}
