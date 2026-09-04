import type { DriftKind } from './drift'

/**
 * Who fixes a drifted article, and how much of the merchant's trust it costs to
 * do it.
 *
 * The rule the product is built around: we may quietly correct a fact on a page
 * we wrote and published on the merchant's behalf, and we may not quietly
 * rewrite it. Correcting a fact is what they turned auto-repair on for.
 * Rewriting is a piece of writing they never saw, appearing on their site under
 * their name, and that needs a day of the calendar and the full quality
 * pipeline like any other piece of writing.
 *
 * A store that publishes by downloading gets neither: nothing of ours ever
 * touches their site, so every repair reaches them as a card saying what
 * happened and offering the corrected download.
 */

export type RepairRoute =
  /** We correct our copy and put the corrected version back on the merchant's shop ourselves. */
  | 'mechanical_auto'
  /** We correct our copy and tell the merchant; nothing is written to their site. */
  | 'action_card'
  /** Nothing can be corrected without new prose, so it goes back through writing and grading. */
  | 'gate3_refresh'

export type RepairAction = 'FIX' | 'REFRESH'

export interface RepairRoutingContext {
  /** How this article reaches the merchant: posted by us, or downloaded by them. */
  readonly delivery: 'auto' | 'export'
  /** The merchant's own setting, and only meaningful for a store we publish for. */
  readonly autoRepair: boolean
  /**
   * A product in the same family that could stand in for the vanished one.
   * Absent means the sentence naming it cannot be mended without being
   * rewritten.
   */
  readonly substituteAvailable: boolean
}

export interface RepairRouting {
  readonly action: RepairAction
  readonly route: RepairRoute
  /**
   * Why this route and not another, in the vocabulary the decision journal and
   * the log use. Never shown to a merchant.
   */
  readonly reason:
    | 'swap_in_family'
    | 'no_in_family_substitute'
    | 'recommendation_itself_is_wrong'
    | 'article_built_on_axes_that_moved'
    | 'merchant_publishes_by_download'
    | 'auto_repair_switched_off'
}

/**
 * Chosen from the whole situation rather than looked up from the kind of event.
 *
 * The same product disappearing is a one-line correction on a store that sells
 * three near-identical versions of it, and a rewrite on a store that sold only
 * that one. Deciding from the event alone would get one of those two wrong
 * every time.
 */
export function routeRepair(kind: DriftKind, context: RepairRoutingContext): RepairRouting {
  // A range that no longer differs the way the article compared it, and a
  // product nobody can buy, are both problems with what the article *says*.
  // No amount of re-pointing a reference mends a sentence whose reasoning has
  // stopped being true, so these never take the mechanical path — however the
  // store publishes, and whatever the auto-repair setting says.
  if (kind === 'family_axes_changed') {
    return { action: 'REFRESH', route: 'gate3_refresh', reason: 'article_built_on_axes_that_moved' }
  }
  if (kind === 'product_out_of_stock') {
    return {
      action: 'REFRESH',
      route: 'gate3_refresh',
      reason: 'recommendation_itself_is_wrong',
    }
  }
  if (kind === 'collection_deleted') {
    // Nothing about any article is wrong; the catalogue's own grouping is what
    // has to be redone. Routed here for completeness of the table rather than
    // because an article is waiting on it.
    return { action: 'FIX', route: 'action_card', reason: 'no_in_family_substitute' }
  }

  if (!context.substituteAvailable) {
    return { action: 'REFRESH', route: 'gate3_refresh', reason: 'no_in_family_substitute' }
  }
  if (context.delivery === 'export') {
    return { action: 'FIX', route: 'action_card', reason: 'merchant_publishes_by_download' }
  }
  if (!context.autoRepair) {
    return { action: 'FIX', route: 'action_card', reason: 'auto_repair_switched_off' }
  }
  return { action: 'FIX', route: 'mechanical_auto', reason: 'swap_in_family' }
}

/** Whether this route puts a corrected body back on the merchant's own shop. */
export function routeWritesToShop(route: RepairRoute): boolean {
  return route === 'mechanical_auto'
}
