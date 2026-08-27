import type { DeepPartial, RulesLayer } from './types.js'

/**
 * main §7.10: "Overrides are layered: global defaults -> per-locale -> (later)
 * per-store / per-market / per-query-type / per-page-type. V1 ships global +
 * per-locale; the override tables exist in the schema (§13) even if empty."
 *
 * This is the reader for that table (`rules_overrides`, main §13). V1 wires the
 * null implementation: the table exists, nothing writes to it, and the reader
 * returns nothing — so the layering code path is real and exercised rather than
 * being retrofitted later.
 */

export interface RulesOverrideScope {
  accountId?: string
  locale?: string
  pageType?: string
}

/** One row of `rules_overrides` (main §13), already parsed into a partial layer. */
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
