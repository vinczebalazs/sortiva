import { spendAttribution, type CostLedger, type SpendEvent } from '@sortiva/core'
import type { Db } from './client'
import { appendSpendEvent } from './repositories/spend'
import { accountScope, systemScope } from './scope'

/**
 * The production adapter for main §14.5's spend meter. Before it, the only
 * `CostLedger` in the repository was `UnrecordedSpend` — a deliberate no-op —
 * so both paid-vendor wrappers recorded every cost to PostHog and nothing to
 * our own database, and the caps in `packages/rules/signals.config.yaml` had
 * no meter to read (`docs/audits/remediation.md` D10 item 1).
 *
 * All the shape decisions are the port's, in
 * `packages/core/src/contracts/spend.ts`; this class is the seam between that
 * port and the `spend_events` table, and does no thinking of its own beyond
 * choosing the scope the row is written under.
 *
 * `record` throws on a failed write, like any repository call. The policy for
 * what that means — logged, never raised into the caller, because the vendor is
 * already paid — belongs to `recordSpend()`, which is the one place the
 * wrappers write through.
 */
export class PostgresCostLedger implements CostLedger {
  private static readonly PREVIEW_SCOPE = systemScope(
    'preview spend precedes any account; §14.7 attributes it to the target domain instead',
  )

  constructor(private readonly db: Db) {}

  async record(event: SpendEvent): Promise<void> {
    const { accountId, previewTarget } = spendAttribution(event.attribution)
    const row = {
      vendor: event.vendor,
      callType: event.callType,
      usdCost: event.usdCost,
      cacheHit: event.cacheHit,
      outcome: event.outcome,
      occurredAt: event.occurredAt,
    }
    await (accountId === null
      ? appendSpendEvent(this.db, PostgresCostLedger.PREVIEW_SCOPE, { ...row, previewTarget })
      : appendSpendEvent(this.db, accountScope(accountId), row))
  }
}
