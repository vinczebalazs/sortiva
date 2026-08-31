import type { JobStepName } from './steps'

/**
 * main §14.3.1 — "restarting a job just means re-dispatching non-succeeded
 * steps." A step killed mid-flight leaves its row in `running`, and `running` is
 * not `succeeded`; without a rule for how long that state may last, "re-dispatch
 * the non-succeeded steps" cannot tell a live worker from a dead one, and the
 * row is never offered again.
 *
 * A lease is that rule: the longest a `running` row is believed to belong to a
 * live worker. Past it the row is reclaimable — `dispatchableSteps` offers it and
 * `claimStep` will take it. Reclaiming is safe because §14.3.3's per-account lock
 * already means at most one worker touches an account's steps at a time, so a
 * lease that expires early costs a duplicated attempt, never two live writers.
 *
 * Durations are not in the spec; §14.3.3's "steps are sized to minutes, not
 * hours" and the ~8-minute worst case it gives for `catalog_sync` are what they
 * are chosen against. See DECISIONS 2026-08-31 R1.
 */

const MINUTE_MS = 60_000

/** Every step that does real work and has no bespoke budget. */
export const DEFAULT_STEP_LEASE_MS = 15 * MINUTE_MS

/**
 * `null` means *no lease*: the step is parked waiting for something outside this
 * process (a merchant finishing OAuth, choosing a Search Console property, or
 * confirming onboarding). Those legitimately sit in `running` for days, so a
 * timer must never reclaim them; they are un-parked by the event they wait on,
 * and the merchant is chased by the reminder sweeps (tech §1.4) instead.
 */
export const STEP_LEASE_MS: Readonly<Record<JobStepName, number | null>> = {
  detect: DEFAULT_STEP_LEASE_MS,
  oauth_wait: null,
  // §14.3.3 — "~8 minutes worst case" for a 500-product store at the §14.4
  // rate budget. Doubled, so a slow store is late rather than reclaimed.
  catalog_sync: 30 * MINUTE_MS,
  distill: 30 * MINUTE_MS,
  family_group: DEFAULT_STEP_LEASE_MS,
  persona: DEFAULT_STEP_LEASE_MS,
  keywords_competitors: DEFAULT_STEP_LEASE_MS,
  gsc_connect: null,
  awaiting_confirmation: null,
}

export function leaseMsFor(step: JobStepName): number | null {
  const ms = STEP_LEASE_MS[step]
  // `??` would be wrong here: `null` is a deliberate "never reclaim this one",
  // not a missing entry, and collapsing the two would put a 15-minute timer on
  // the steps that wait for a merchant.
  return ms === undefined ? DEFAULT_STEP_LEASE_MS : ms
}

/**
 * The instant before which a `running` row is considered abandoned, or `null`
 * when this step has no lease and may never be reclaimed on a timer.
 *
 * @param overrideMs forces a lease for steps that have none, and shortens the
 * wait in tests and in the chaos scenario. Production passes nothing.
 */
export function leaseExpiryFor(
  step: JobStepName,
  now: Date = new Date(),
  overrideMs?: number | null,
): Date | null {
  const ms = overrideMs === undefined ? leaseMsFor(step) : overrideMs
  if (ms === null) return null
  return new Date(now.getTime() - ms)
}
