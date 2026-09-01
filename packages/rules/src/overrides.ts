import type { DeepPartial, RulesLayer } from './types'

/**
 * Thresholds are layered: global defaults, then per-locale, and eventually
 * per-store / per-market / per-query-type / per-page-type. V1 ships only the
 * first two.
 *
 * This is the reader for the later layers' table, `rules_overrides`, wired to a
 * null implementation: the table exists, nothing writes to it, and the reader
 * returns nothing. The point is that the layering code path is real and
 * exercised now rather than retrofitted under a live system later.
 */

export interface RulesOverrideScope {
  accountId?: string
  locale?: string
  pageType?: string
}

/** One row of `rules_overrides`, already parsed into a partial layer. */
export interface RulesOverrideRow {
  scope: RulesOverrideScope
  patch: DeepPartial<RulesLayer>
  updatedBy: string
  updatedAt: Date
}

export interface RulesOverrideReader {
  /** Rows applying to this scope, least specific first, so callers can fold them in order. */
  read(scope: RulesOverrideScope): Promise<RulesOverrideRow[]>
}

/** V1 default. The table is empty; nothing is layered on top of the repo file. */
export class NullRulesOverrideReader implements RulesOverrideReader {
  async read(): Promise<RulesOverrideRow[]> {
    return []
  }
}
