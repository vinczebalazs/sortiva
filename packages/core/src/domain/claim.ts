import { accountAttribution, type PosthogCapture } from '../contracts/analytics'
import {
  accountHasOtherDomainMessage,
  DOMAIN_ALREADY_CLAIMED_MESSAGE,
  INVALID_DOMAIN_MESSAGE,
} from './copy'
import { InvalidClaimDomain, normaliseClaimDomain } from './normalise'
import type { DomainClaimStore, DomainState } from './ports'

/** One step of the activation funnel: `subscription_activated → domain_claimed → shopify_oauth_granted → …`. */
export const DOMAIN_CLAIMED_EVENT = 'domain_claimed'

/**
 * Derived from its inputs, never random. One
 * account claiming one domain is one ingestion run for the life of that claim,
 * so a retried request cannot start a second onboarding.
 */
export function ingestionRunId(normalized: string): string {
  return `claim:${normalized}`
}

export interface ClaimDomainDeps {
  readonly store: DomainClaimStore
  /** Funnel capture. Optional so the domain logic runs without telemetry. */
  readonly capture?: Pick<PosthogCapture, 'capture'>
}

export type ClaimDomainResult =
  | {
      readonly kind: 'claimed' | 'already_yours'
      readonly normalized: string
      readonly state: DomainState
      readonly ingestionJobId: string
    }
  | { readonly kind: 'taken_by_other'; readonly normalized: string; readonly message: string }
  | {
      readonly kind: 'account_has_other_domain'
      readonly normalized: string
      readonly current: string
      readonly message: string
    }
  | { readonly kind: 'invalid_domain'; readonly message: string }

/**
 * Connecting a domain, end to end: normalise it, claim it against the global
 * unique index, enqueue the deep ingestion job, and hand the dashboard the run
 * to render its progress stepper against.
 *
 * The outcomes are distinguished by the store inside its own transaction rather
 * than by a follow-up read, which could see a different world than the insert
 * did and hand two simultaneous signups the same domain.
 *
 * `domain_claimed` fires only on a real claim: a returning merchant re-pasting
 * their own domain is not a funnel step, and counting it would inflate the
 * activation numbers the same way counting every sign-in as a signup would
 * (T1.1 made the identical choice for `signup_completed`).
 */
export async function claimDomain(
  deps: ClaimDomainDeps,
  input: { accountId: string; domain: string },
): Promise<ClaimDomainResult> {
  let normalized: string
  try {
    normalized = normaliseClaimDomain(input.domain).normalized
  } catch (cause) {
    if (cause instanceof InvalidClaimDomain) {
      return { kind: 'invalid_domain', message: INVALID_DOMAIN_MESSAGE }
    }
    throw cause
  }

  const result = await deps.store.claimWithIngestionRun({
    accountId: input.accountId,
    normalized,
    runId: ingestionRunId(normalized),
  })

  switch (result.kind) {
    case 'claimed':
      deps.capture?.capture({
        event: DOMAIN_CLAIMED_EVENT,
        // The domain group exists from this moment: everything this
        // account spends from here is groupable by the site it spent it on.
        attribution: accountAttribution(input.accountId, normalized),
      })
      return {
        kind: 'claimed',
        normalized,
        state: result.state,
        ingestionJobId: result.ingestionJobId,
      }
    case 'already_yours':
      return {
        kind: 'already_yours',
        normalized,
        state: result.state,
        ingestionJobId: result.ingestionJobId,
      }
    case 'taken_by_other':
      return { kind: 'taken_by_other', normalized, message: DOMAIN_ALREADY_CLAIMED_MESSAGE }
    case 'account_has_other_domain':
      return {
        kind: 'account_has_other_domain',
        normalized,
        current: result.current,
        message: accountHasOtherDomainMessage(result.current),
      }
  }
}
