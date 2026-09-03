import { runSignalScan, type RunSignalScanDeps } from './run'

/**
 * The event-driven cadence row (main §7.5's cadence table: "Shopify webhooks
 * / reconciliation sweep... product-change and broken-reference
 * opportunities are created within the existing drift-handling flow").
 *
 * **Scoped honestly, not to the letter of that row.** The drift-handling flow
 * it names is `T5.3`'s (Lane D, not built), and the two signal types it
 * names — `product_change_impact`, `broken_product_reference` — have no
 * detector anywhere, this card included; nothing produces them yet. What
 * this function actually does instead: the same full catalogue/market
 * detection pass the weekly scan runs, triggered by a real product/catalogue
 * change rather than waiting for Monday, so a merchant who e.g. fixes a
 * missing SEO title or adds a product to a bare family sees that reflected
 * sooner than the next weekly scan. That is a real, useful reading of "event-
 * driven" main §7.5 supports even though the two named drift signals stay
 * exactly where `T5.3` will build them. See DECISIONS 2026-09-03 T3.7.
 */

export async function runEventDrivenScan(
  deps: RunSignalScanDeps,
  accountId: string,
  trigger: { readonly cursor: string },
) {
  return runSignalScan(deps, accountId, 'event', `event-${accountId}-${trigger.cursor}`)
}
