import type { Logger } from '../observability/logger'
import type { EventAttribution } from './analytics'

/**
 * The port the vendor wrappers write our own spend counter through.
 *
 * The daily caps are computed from that counter and never from analytics: a
 * kill switch has to work when the analytics vendor is down or its events are
 * delayed, which is exactly when spend is most likely to be running away. This
 * sits *alongside* the analytics capture, never instead of it — the
 * cost-per-domain and preview-economics dashboards are still built there.
 *
 * The one rule that is not obvious from the shape: **recording a cost is an
 * obligation of making the call, not a side effect of the call succeeding**.
 * Both paid vendors bill for work performed,
 * not for bytes we successfully received, so a vendor error, a rate limit, a
 * timeout, a dropped connection and a stream cut off partway all produce a row
 * — with `outcome: 'failed'`, so a reader can tell them apart afterwards
 * instead of them being silently omitted or falsely counted as successes.
 *
 * A row carries identifiers, counts, costs and flags. There is no field for a
 * prompt, an article, product content or a token
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
   * Who the spend belongs to: a claimed account, or the domain a logged-out
   * visitor asked about. `spend_events` mirrors it as a nullable column pair
   * with a check constraint, so exactly one is always set.
   */
  readonly attribution: EventAttribution
  readonly vendor: SpendVendor
  /** One of our LLM call types, or the vendor endpoint for a SEO-data read. */
  readonly callType: string
  readonly usdCost: number
  /** A replay is recorded at zero rather than omitted, so re-used work shows up as free instead of vanishing. */
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
    return 'a cache hit is free work: cache_hit = true requires usd_cost = 0'
  }
  return undefined
}

/**
 * The seam between the attribution union and the table's column pair. The
 * mapping is an identity by construction — `spend_events` was shaped from
 * `EventAttribution` — and lives here so the adapter that eventually writes to
 * Postgres does not re-derive it.
 */
export function spendAttribution(attribution: EventAttribution): {
  accountId: string | null
  previewTarget: string | null
} {
  return attribution.kind === 'preview'
    ? { accountId: null, previewTarget: attribution.billableDomain }
    : { accountId: attribution.accountId, previewTarget: null }
}

/**
 * **A ledger that writes nothing.** Callers must ask for it by name, so "this
 * spend is not being counted" is always a visible choice in the code rather
 * than the default that a missing argument silently produces.
 *
 * Legitimate uses: a unit test that asserts something other than cost, and a
 * local development process with no database. Never production — the daily caps
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

  /** What the daily caps would read. */
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
 * the failure path it would replace the vendor's error — which is what the
 * retry classification reads — with a database error. So the write is
 * best-effort and *loud*: an unrecorded cost is logged at error level, because
 * it means the caps are reading low and nobody would otherwise know.
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
