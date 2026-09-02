import { accountAttribution, type EventAttribution } from '../contracts/analytics'
import { appServices, appServicesInitialised } from '../runtime/services'
import { createLogger } from './logger'
import type { Logger } from './logger'

/**
 * **Where an error nobody handled goes.**
 *
 * Without this, an unhandled error prints to stdout and stops there: nothing
 * alerts, nothing groups two hundred copies of the same fault into one issue,
 * and nobody finds out until a merchant writes in. The analytics client already
 * knows how to report an exception — it is the same sink the rest of our
 * telemetry uses, and it scrubs secrets out of messages and stack frames on the
 * way — it simply had no caller.
 *
 * Two properties are deliberate:
 *
 *  - **It reads the process's service bundle rather than taking a client.** The
 *    two places that call it are a Next error hook and the job runtime, both
 *    invoked by their framework with no caller of ours to hand them anything —
 *    the same boundary exception `runtime/services.ts` describes. Nothing is
 *    ever read back from it: this is telemetry, never a control plane.
 *  - **It cannot throw.** A reporter that fails while reporting a failure turns
 *    one fault into two, and the second one has nowhere to go.
 *
 * Kept out of the `@sortiva/core` barrel on purpose, exactly like the service
 * bundle it reads: a domain module quietly acquiring the ability to report
 * crashes should be visible in a grep, not hidden behind an existing import.
 */

/**
 * Who a crash is attributed to when no account is involved — a request with no
 * session, a sweep that belongs to nobody.
 *
 * A sentinel rather than a third kind of attribution because `EventAttribution`
 * is a frozen contract (`contracts/analytics.ts`) that a single card may not
 * re-shape. It carries no domain group, so it cannot pollute any store's cost
 * numbers; it simply groups every ownerless crash under one id.
 */
export const SYSTEM_ACTOR = 'system'

export function systemAttribution(): EventAttribution {
  return accountAttribution(SYSTEM_ACTOR)
}

export interface CrashReport {
  /** Whose work was being done. Defaults to the system actor. */
  attribution?: EventAttribution
  /**
   * Where it happened and what class of failure it was. Ids, counts, states and
   * error classes only — never a product title, an article body or a prompt.
   */
  properties?: Record<string, unknown>
  logger?: Logger
}

export function reportCrash(error: unknown, report: CrashReport = {}): void {
  const attribution = report.attribution ?? systemAttribution()
  const properties = report.properties ?? {}
  const log = report.logger ?? createLogger()

  // Logged as well as captured, always. The log line is what someone tailing a
  // deploy sees; the capture is what alerts and groups. Losing either one is
  // how a fault becomes invisible in the place people happen to be looking.
  log.error('unhandled_error', {
    ...properties,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  })

  try {
    if (!appServicesInitialised()) {
      // A process that never built its service bundle has no sink to send to.
      // Said once, in the same breath as the error, rather than swallowed —
      // otherwise "crashes are reported" is true only where someone remembered
      // to initialise.
      log.warn('crash_capture_skipped', { reason: 'app services are not initialised' })
      return
    }
    appServices().analytics.captureException(error, attribution, properties)
  } catch (failure) {
    log.warn('crash_capture_failed', {
      reason: failure instanceof Error ? failure.message : String(failure),
    })
  }
}
