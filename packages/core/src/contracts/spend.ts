import type { Logger } from '../observability/logger'
import type { EventAttribution } from './analytics'

/**
 * main §14.7 — "The §14.5 budget auto-trips read spend from our own DB counters
 * — PostHog displays cost, our code enforces caps", and "PostHog is telemetry
 * and alerting, **not** the control plane… a kill switch must work when PostHog
 * is down or events are sampled/delayed." Constitution invariant 17 restates it.
 *
 * This is the port the wrappers write that counter through. It sits *alongside*
 * the PostHog capture, never instead of it: §14.7 also specs the cost-per-domain
 * and preview-economics dashboards, which are PostHog insights.
 *
 * The one rule that is not obvious from the shape: **recording a cost is an
 * obligation of making the call, not a side effect of the call succeeding**
 * (`docs/audits/remediation.md` D2). Both paid vendors bill for work performed,
 * not for bytes we successfully received, so a vendor error, a rate limit, a
 * timeout, a dropped connection and a stream cut off partway all produce a row
 * — with `outcome: 'failed'`, so a reader can tell them apart afterwards
 * instead of them being silently omitted or falsely counted as successes.
 *
 * Privacy (invariant 26 / §14.7): a row carries identifiers, counts, costs and
 * flags. There is no field for a prompt, an article, product content or a token
 * value, so none can be written by accident.
 */

/** The three instrumented wrappers of invariant 25 that cost money. Mirrors the DB's `spend_vendor` enum. */
export type SpendVendor = 'anthropic' | 'dataforseo' | 'resend'

/**
 * Whether the call yielded usable data. A call the vendor billed but whose
 * answer we could not store or parse is `failed`: the money left either way,
 * which is why the row exists at all. Mirrors the DB's `spend_outcome` enum.
 */
export type SpendOutcome = 'succeeded' | 'failed'

export interface SpendEvent {
  /**
   * §14.7's preview attribution rule as a union: a claimed account, or the
   * domain a logged-out visitor asked about. `spend_events` mirrors it as a
   * nullable column pair with a check constraint, so exactly one is set.
   */
  readonly attribution: EventAttribution
  readonly vendor: SpendVendor
  /** The LLM `call_type` (§14.7's list), or the vendor endpoint for DataForSEO. */
  readonly callType: string
  readonly usdCost: number
  /** §14.7 requirement (3) — a replay is recorded at zero, never omitted. */
  readonly cacheHit: boolean
  readonly outcome: SpendOutcome
  readonly occurredAt?: Date
}

export interface CostLedger {
  /** Appends one row. Never updates: a cost that was incurred is not revised. */
  record(event: SpendEvent): Promise<void>
}

/**
 * The DB's three check constraints on `spend_events`, as a function, so a
 * wrapper's own test suite rejects a bad row before Postgres would. Returns the
 * violated rule, or undefined.
 */
export function spendEventViolation(event: SpendEvent): string | undefined {
  if (event.usdCost < 0) return 'usd_cost must be >= 0'
  if (event.cacheHit && event.usdCost !== 0) {
    return 'a cache hit is free work: cache_hit = true requires usd_cost = 0 (main §14.7 requirement 3)'
  }
  return undefined
}

/**
 * The seam between §14.7's attribution union and the table's column pair. The
 * mapping is an identity by construction — `spend_events` was shaped from
 * `EventAttribution` — and lives here so the adapter that eventually writes to
 * Postgres does not re-derive it.
 */
export function spendAttribution(attribution: EventAttribution): {
  accountId: string | null
  previewTarget: string | null
} {
  return attribution.kind === 'preview'
    ? { accountId: null, previewTarget: attribution.targetDomain }
    : { accountId: attribution.accountId, previewTarget: null }
}

/**
 * **A ledger that writes nothing.** Callers must ask for it by name, so "this
 * spend is not being counted" is always a visible choice in the code rather
 * than the default that a missing argument silently produces (audit
 * `docs/audits/T0.5.md` finding 6).
 *
 * Legitimate uses: a unit test that asserts something other than cost, and a
 * local development process with no database. Never production — the §14.5 caps
 * read this counter, and a wrapper wired to this one spends real money and
 * produces no meter reading.
 */
export class UnrecordedSpend implements CostLedger {
  async record(_event: SpendEvent): Promise<void> {}
}

/**
 * Test double. It enforces the same constraints the table does, so a test that
 * passes against it would not be rejected by Postgres, and it can be told to
 * fail — because "the ledger write itself failed" is a path the wrappers have
 * to survive without losing the vendor's answer or masking the vendor's error.
 */
export class InMemoryCostLedger implements CostLedger {
  readonly rows: (SpendEvent & { occurredAt: Date })[] = []

  /** When set, every `record` rejects with it — a ledger outage, in a test. */
  failWith: Error | undefined

  constructor(private readonly now: () => Date = () => new Date()) {}

  async record(event: SpendEvent): Promise<void> {
    if (this.failWith) throw this.failWith
    const violation = spendEventViolation(event)
    if (violation) {
      throw new Error(`spend_events would reject this row: ${violation}`)
    }
    this.rows.push({ ...event, occurredAt: event.occurredAt ?? this.now() })
  }

  reset(): void {
    this.rows.length = 0
    this.failWith = undefined
  }

  of(vendor: SpendVendor): (SpendEvent & { occurredAt: Date })[] {
    return this.rows.filter((r) => r.vendor === vendor)
  }

  withOutcome(outcome: SpendOutcome): (SpendEvent & { occurredAt: Date })[] {
    return this.rows.filter((r) => r.outcome === outcome)
  }

  /** What the §14.5 caps would read. */
  get totalUsdCost(): number {
    return this.rows.reduce((total, r) => total + r.usdCost, 0)
  }
}

/**
 * The one place the wrappers write the ledger, so the failure policy is decided
 * once.
 *
 * A ledger write that throws does **not** fail the call. The vendor has already
 * been paid and, on the success path, its answer is already cached; turning a
 * database hiccup into a job failure would throw away work we bought, and on
 * the failure path it would replace the vendor's error — which the retry
 * classification of §14.3.5 depends on — with a database error. So the write is
 * best-effort and *loud*: an unrecorded cost is logged at error level, because
 * it means the §14.5 caps are reading low.
 */
export async function recordSpend(
  ledger: CostLedger,
  event: SpendEvent,
  logger?: Logger,
): Promise<void> {
  try {
    await ledger.record(event)
  } catch (error) {
    logger?.error('spend_event_not_recorded', {
      vendor: event.vendor,
      call_type: event.callType,
      usd_cost: event.usdCost,
      outcome: event.outcome,
      cache_hit: event.cacheHit,
      error,
    })
  }
}
