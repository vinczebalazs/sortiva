import { accountAttribution, type PosthogCapture } from '../contracts/analytics'
import {
  accountHasOtherDomainMessage,
  DOMAIN_ALREADY_CLAIMED_MESSAGE,
  INVALID_DOMAIN_MESSAGE,
} from './copy'
import { InvalidClaimDomain, normaliseClaimDomain } from './normalise'
import type { DomainClaimStore, DomainState } from './ports'

/** main §14.7 funnel: `subscription_activated → domain_claimed → shopify_oauth_granted → …`. */
export const DOMAIN_CLAIMED_EVENT = 'domain_claimed'

/**
 * main §14.3.2 — an idempotency key derived from its inputs, never random. One
 * account claiming one domain is one ingestion run for the life of that claim,
 * so a retried request cannot start a second onboarding.
 */
export function ingestionRunId(normalized: string): string {
  return `claim:${normalized}`
}

export interface ClaimDomainDeps {
  readonly store: DomainClaimStore
  /** main §14.7 — funnel capture. Optional so the domain logic runs without telemetry. */
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
 * main §5 — connecting a domain, end to end: normalise (§2), claim against the
 * global unique index, enqueue the deep ingestion job, and hand the dashboard
 * the run to render its progress stepper against (ui §3.2).
 *
 * The three outcomes §5 asks for are three outcomes here, distinguished by the
 * store inside its transaction rather than by a follow-up read that could see a
 * different world than the insert did.
 *
 * `domain_claimed` fires only on a real claim: a returning merchant re-pasting
 * their own domain is not a funnel step, and counting it would inflate main
 * §14.7's activation numbers the same way counting every sign-in as a signup
 * would (T1.1 made the identical choice for `signup_completed`).
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
        // §14.7 — the domain group exists from this moment: everything this
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
