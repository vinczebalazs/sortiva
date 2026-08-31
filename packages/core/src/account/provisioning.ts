import type { EventAttribution, PosthogCapture } from '../contracts/analytics'
import { accountAttribution } from '../contracts/analytics'

/**
 * main §4.1 — "an account is created with `domain = null`". This is what runs
 * on a first successful sign-in, whichever provider carried it.
 *
 * The store is a port rather than a repository import because `packages/core`
 * holds domain logic and owns no persistence (CLAUDE.md code-structure rules);
 * `apps/web` binds it to `@sortiva/db`.
 */
export interface AccountStore {
  /**
   * Insert-with-conflict on the unique email index, then read back on conflict.
   * `created` distinguishes a signup from a returning sign-in — main §5's
   * pattern, applied to identity so two simultaneous callbacks cannot both
   * create an account.
   */
  createOrFindByEmail(email: string): Promise<{ accountId: string; created: boolean }>
}

export interface ProvisionAccountDeps {
  readonly store: AccountStore
  /** main §14.7 — funnel capture. Optional so the domain logic runs without telemetry. */
  readonly capture?: Pick<PosthogCapture, 'capture'>
}

export interface ProvisionedAccount {
  readonly accountId: string
  /** True only when this call created the row — the signup moment. */
  readonly created: boolean
}

/** main §14.7 funnel: `preview_requested → preview_served → signup_completed → …`. */
export const SIGNUP_COMPLETED_EVENT = 'signup_completed'

/**
 * Email is the account identity (main §4.1), so a Google sign-in and an email
 * sign-in on the same address are the same account rather than two.
 *
 * `signup_completed` fires only on the create. Capturing it on every sign-in
 * would inflate the funnel and, with it, main §14.7's "cost per acquired
 * signup". The event carries no domain group: §14.7 reserves that group for
 * claimed domains and a fresh account has none.
 */
export async function provisionAccount(
  deps: ProvisionAccountDeps,
  input: { email: string; provider: string },
): Promise<ProvisionedAccount> {
  const normalizedEmail = input.email.trim().toLowerCase()
  if (!normalizedEmail) throw new Error('provisionAccount requires an email')

  const { accountId, created } = await deps.store.createOrFindByEmail(normalizedEmail)

  if (created) {
    const attribution: EventAttribution = accountAttribution(accountId)
    deps.capture?.capture({
      event: SIGNUP_COMPLETED_EVENT,
      attribution,
      properties: { provider: input.provider },
    })
  }

  return { accountId, created }
}
