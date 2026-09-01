import type { ClaimDomainDeps } from '@sortiva/core'
import { PosthogServerCapture } from '@sortiva/providers'
import { makeDomainClaimStore } from './store'

/**
 * The claim's process-wide wiring, built lazily: PostHog needs a key that does
 * not exist at build time, and a module-level client would fail `next build`.
 */

let capture: PosthogServerCapture | undefined

/** main §14.7 — `domain_claimed` is a funnel event, captured server-side. */
export function claimDeps(): ClaimDomainDeps {
  capture ??= new PosthogServerCapture()
  return { store: makeDomainClaimStore(), capture }
}
