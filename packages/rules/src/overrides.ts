import type { RulesLayer } from './types'

/**
 * Thresholds are layered: global defaults, then per-locale, then the rows of
 * `rules_overrides` — one store, one language, one page type — folded on top,
 * least specific first.
 *
 * The first two layers live in `signals.config.yaml`, which is hashed into
 * `rules_version`. Rows in the table are *not* in that file, so a store carrying
 * one is judged by numbers that hash cannot account for. That is why
 * `resolve()` in `load.ts` returns a version of its own rather than the plain
 * file hash.
 *
 * A row names one number and its new value, never a whole subtree — see
 * `assertOverridableKey`. Overriding `gates` wholesale would let a single row
 * delete every threshold under it, and the operator who wrote it would find out
 * from a store's behaviour rather than from a refusal.
 */

export interface RulesOverrideScope {
  accountId?: string
  locale?: string
  pageType?: string
}

/** One row of `rules_overrides`: a dotted path into a layer, and the value to put there. */
export interface RulesOverrideRow {
  scope: RulesOverrideScope
  /** e.g. `gates.demand_floor.monthly_search_volume_min`. */
  key: string
  value: unknown
  updatedBy: string
  updatedAt: Date
}

export interface RulesOverrideReader {
  /** Rows applying to this scope, least specific first, so callers can fold them in order. */
  read(scope: RulesOverrideScope): Promise<RulesOverrideRow[]>
}

/**
 * For a process that has the config but no database — the eval runners, and any
 * caller that wants the repo file's numbers and nothing else. No longer the
 * default: the weekly scan reads the table.
 */
export class NullRulesOverrideReader implements RulesOverrideReader {
  async read(): Promise<RulesOverrideRow[]> {
    return []
  }
}

/**
 * Refusal to apply an override. Thrown rather than swallowed: a threshold that
 * quietly fails to apply is worse than one that was never set, because the
 * operator believes it is in force and the store's behaviour is the only thing
 * that says otherwise.
 */
export class RulesOverrideError extends Error {
  constructor(
    message: string,
    readonly detail: string[] = [],
  ) {
    super(detail.length > 0 ? `${message}\n  - ${detail.join('\n  - ')}` : message)
    this.name = 'RulesOverrideError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** How narrowly a row is aimed. Higher wins; the fold applies lower first. */
export function overrideSpecificity(scope: RulesOverrideScope): number {
  // A row for one store beats a row for its language, which beats a row for a
  // page type. Powers of two, so no combination can tie with a different one.
  return (scope.accountId ? 4 : 0) + (scope.locale ? 2 : 0) + (scope.pageType ? 1 : 0)
}

/**
 * Whether a row applies to a request. An unset column on the row is a wildcard;
 * a set column must match exactly. A row aimed at a page type does **not**
 * apply to a request that names no page type, so a page-level number never
 * leaks into a store-wide decision.
 */
export function overrideApplies(row: RulesOverrideScope, wanted: RulesOverrideScope): boolean {
  if (row.accountId !== undefined && row.accountId !== wanted.accountId) return false
  if (row.locale !== undefined && row.locale !== wanted.locale) return false
  if (row.pageType !== undefined && row.pageType !== wanted.pageType) return false
  return true
}

/**
 * Least specific first, so a caller folding in order ends with the narrowest
 * row on top. Rows of equal specificity are ordered by when they were written
 * and then by key, so two operators racing produce one answer rather than
 * whichever the database happened to return first.
 */
export function sortOverrides(rows: readonly RulesOverrideRow[]): RulesOverrideRow[] {
  return [...rows].sort((a, b) => {
    const bySpecificity = overrideSpecificity(a.scope) - overrideSpecificity(b.scope)
    if (bySpecificity !== 0) return bySpecificity
    const byTime = a.updatedAt.getTime() - b.updatedAt.getTime()
    if (byTime !== 0) return byTime
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
}

/** Human-readable form of a row's aim, for error messages and the operator listing. */
export function describeScope(scope: RulesOverrideScope): string {
  const parts: string[] = []
  if (scope.accountId) parts.push(`account ${scope.accountId}`)
  if (scope.locale) parts.push(`locale ${scope.locale}`)
  if (scope.pageType) parts.push(`page type ${scope.pageType}`)
  return parts.length > 0 ? parts.join(', ') : 'every store'
}

function valueAtPath(layer: RulesLayer, path: readonly string[]): unknown {
  let cursor: unknown = layer
  for (const segment of path) {
    if (!isPlainObject(cursor)) return undefined
    cursor = cursor[segment]
  }
  return cursor
}

function jsonKind(value: unknown): string {
  if (Array.isArray(value)) return 'list'
  if (value === null) return 'null'
  return typeof value
}

/**
 * Refuses a key that does not name one existing number (or flag, or list) in
 * the defaults, and returns the path split into segments.
 *
 * This is the check that catches a typo. `demand_flooor` names nothing, so
 * without it the row would merge in as a brand new field that no code ever
 * reads — the operator's number would be stored, and ignored, silently.
 */
export function assertOverridableKey(defaults: RulesLayer, key: string): string[] {
  const path = key.split('.')
  if (path.length < 2 || path.some((segment) => segment.length === 0)) {
    throw new RulesOverrideError(
      `"${key}" is not a threshold path. Use the dotted name of one number, e.g. gates.demand_floor.monthly_search_volume_min.`,
    )
  }
  const existing = valueAtPath(defaults, path)
  if (existing === undefined) {
    throw new RulesOverrideError(`"${key}" is not a threshold this product has.`)
  }
  if (isPlainObject(existing)) {
    throw new RulesOverrideError(
      `"${key}" names a group of thresholds, not one number. Override the individual numbers under it instead.`,
    )
  }
  return path
}

/** Refuses a value of the wrong shape before the merged layer is built, so the message can name the row. */
export function assertOverrideValue(defaults: RulesLayer, key: string, value: unknown): string[] {
  const path = assertOverridableKey(defaults, key)
  const existing = valueAtPath(defaults, path)
  if (jsonKind(existing) !== jsonKind(value)) {
    throw new RulesOverrideError(
      `"${key}" is a ${jsonKind(existing)}; this override supplies a ${jsonKind(value)}.`,
    )
  }
  return path
}

/** `["a","b","c"]` + 7 → `{a: {b: {c: 7}}}`, ready to merge onto a layer. */
export function patchFromKey(path: readonly string[], value: unknown): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  let cursor = patch
  for (let index = 0; index < path.length - 1; index += 1) {
    const next: Record<string, unknown> = {}
    cursor[path[index] as string] = next
    cursor = next
  }
  cursor[path[path.length - 1] as string] = value
  return patch
}
