import type { FamilyGroupingSource } from './cluster'

/**
 * The confirmation screen's grouping-source badge, and the same badge on the
 * Products screen (ui §3.7 item 5).
 *
 * The frozen response schema's `familySchema.groupingSource` names three
 * values — `taxonomy | fact_clustering | embedding` — and the database's
 * `family_grouping_source` enum names four: it also has `split_variant`, for a
 * family built by recognising that several Shopify products are one logical
 * product sold in different options. `T2.4` flagged the mismatch and left it
 * for whichever route exposes a family to resolve (DECISIONS 2026-09-02 T2.4).
 *
 * `collection` maps onto `taxonomy` cleanly: despite its name, that signal
 * reads the merchant's own `product_type` field, not a Shopify collection
 * (DECISIONS 2026-09-02 T2.4, "Collections are not a grouping signal") — it
 * *is* the merchant's taxonomy. `split_variant` has no equivalent in the
 * three-value schema; it is reported as `fact_clustering` because both are
 * grouped from the product data itself rather than from the merchant's own
 * filing or the embedding fallback. This is an approximation, not a perfect
 * mapping — the next contract re-freeze should give `split_variant` its own
 * value.
 */
export function familyGroupingSourceForScreen(
  source: FamilyGroupingSource,
): 'taxonomy' | 'fact_clustering' | 'embedding' {
  switch (source) {
    case 'collection':
      return 'taxonomy'
    case 'split_variant':
    case 'fact_cluster':
      return 'fact_clustering'
    case 'embedding':
      return 'embedding'
  }
}
