/**
 * Every seam between parallel lanes is an interface with a test double, and a
 * consumer card may pass its tests against the double. That is
 * only safe if the repo can always answer "which stubs are still wired?" — so
 * every stub registers itself here and every call it serves emits `stub_used`.
 *
 * The plan's own rule: "a CI check fails if any stub is still wired at M3 exit".
 * `pnpm stubs:report` is that check. Through M0 it is expected to list all of
 * them; `--fail-if-any` is what the later milestone gates turn on.
 *
 * Why a registry rather than a comment convention: a stub that quietly ships is
 * a feature that silently does nothing. `existingTargetCheck` returning
 * `no_match` forever means every CREATE bypasses the check that stops us
 * publishing a second page competing with one we already have — and nothing
 * would look broken.
 */

import type { PosthogCapture, EventAttribution } from './analytics'

export interface StubRegistration {
  /** The contract's name. */
  readonly contract: string
  /** The card that replaces this stub with the real implementation. */
  readonly filledBy: string
  /** What the stub does instead, in one line. */
  readonly behaviour: string
  /** The milestone by which it must be gone. */
  readonly mustBeGoneBy: string
}

const registry = new Map<string, StubRegistration>()

export function registerStub(registration: StubRegistration): void {
  registry.set(registration.contract, registration)
}

export function wiredStubs(): readonly StubRegistration[] {
  return [...registry.values()].sort((a, b) => a.contract.localeCompare(b.contract))
}

/** Test-only: drops the registry so one suite's registrations cannot affect another's. */
export function resetStubRegistry(): void {
  registry.clear()
}

/**
 * Emitted every time a stub actually serves a call, so the gap between "wired"
 * and "in the hot path" is visible in PostHog rather than inferred from code.
 */
export function captureStubUsed(
  capture: Pick<PosthogCapture, 'capture'> | undefined,
  contract: string,
  attribution: EventAttribution,
  properties: Record<string, unknown> = {},
): void {
  capture?.capture({
    event: 'stub_used',
    attribution,
    properties: { contract, ...properties },
  })
}

/**
 * Shared plumbing for the doubles below: registers on construction and captures
 * on every call, so no double has to remember to do either.
 */
export abstract class StubImplementation {
  protected constructor(
    registration: StubRegistration,
    protected readonly capture?: Pick<PosthogCapture, 'capture'>,
  ) {
    this.contract = registration.contract
    registerStub(registration)
  }

  readonly contract: string
  /** Every call this stub served, for tests that assert a consumer reached the seam. */
  readonly calls: { method: string; attribution: EventAttribution }[] = []

  protected record(
    method: string,
    attribution: EventAttribution,
    properties: Record<string, unknown> = {},
  ): void {
    this.calls.push({ method, attribution })
    captureStubUsed(this.capture, this.contract, attribution, { method, ...properties })
  }
}
