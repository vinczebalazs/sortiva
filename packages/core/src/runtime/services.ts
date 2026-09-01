import type { PosthogCapture } from '../contracts/analytics'

/**
 * **How the app supplies shared, process-wide services** — the analytics client
 * today, and whatever later cards add beside it.
 *
 * The shape is a *composition root*: exactly one place per process (the entry
 * point — `apps/web/instrumentation.ts`) knows which concrete adapters exist and
 * builds them once; everything below it receives a port as a required argument
 * and never reaches for a global. `AnthropicLlmClient` and `DataForSeoProvider`
 * already work that way (a required `capture`, with `UnrecordedCapture` as the
 * named opt-out), and that stays the rule for anything constructed with `new`.
 *
 * This module is the small exception those two cannot cover: a Next route
 * handler and a Graphile task handler are called *by their framework*, so no
 * caller of ours can hand them anything. They read the bundle here — at the
 * process boundary — and pass it inward.
 *
 * Three properties are structural rather than conventional:
 *
 *  - **Built at most once.** `initAppServices` takes a factory and memoises it,
 *    so a second call cannot produce a second PostHog client. Two clients means
 *    two batches, and the drain flushes only one of them.
 *  - **Ports only.** The bundle's fields are the interfaces in
 *    `../contracts/`, so `packages/core` still imports no provider SDK
 *    (CLAUDE.md code-structure rules; `boundaries.test.ts` proves it).
 *  - **Not in the `@sortiva/core` barrel.** Domain code imports the barrel; this
 *    module has to be asked for by name (`@sortiva/core/runtime/services`), so
 *    a domain module quietly acquiring ambient telemetry is visible in review
 *    and in a grep, not hidden behind an existing import.
 *
 * PostHog remains telemetry, never the control plane (main §14.7, constitution
 * invariant 17): nothing here reads back from the analytics client, and no
 * kill switch, cap or entitlement check may. Those read the database.
 */
export interface AppServices {
  /**
   * main §14.7's server-side capture. Every event carries ids, counts, costs
   * and flags only — never product content, prompts or article text
   * (invariant 26).
   */
  readonly analytics: PosthogCapture
}

let services: AppServices | undefined

/**
 * Builds the process's services on the first call and returns the same bundle
 * on every later one. The factory runs at most once per process, so "construct
 * the analytics client once at startup" is enforced here rather than trusted to
 * every entry point.
 */
export function initAppServices(create: () => AppServices): AppServices {
  services ??= create()
  return services
}

/**
 * The bundle, for code the framework calls directly. Throws rather than
 * returning a silent no-op: an entry point that forgot to initialise is a
 * deployment fault to fix, not telemetry to lose quietly — which is the exact
 * failure this card exists to end.
 */
export function appServices(): AppServices {
  if (!services) {
    throw new Error(
      'app services are not initialised — the process entry point must call initAppServices() first (apps/web/instrumentation.ts)',
    )
  }
  return services
}

/** True once the entry point has built the bundle. For code that must not throw. */
export function appServicesInitialised(): boolean {
  return services !== undefined
}

/** Test-only: one suite's process-wide bundle must not leak into the next. */
export function resetAppServices(): void {
  services = undefined
}
