import { type RulesLayer, rules } from '@sortiva/rules'
import { type SignalScenario, type SyntheticGscRow, type SyntheticProduct, type SyntheticStore, scenario } from '../fixtures'
import { type FactSheet, emptyFactSheet } from '../distill/schema'
import { buildQueryClusters, type ClusterDefinition, type ClusterShareRow } from '../search'
import { type DetectionWindow, type PageFact, indexPages } from './types'
import type { ProductSubstance } from './substance'

/**
 * Turning a worked example into detector input.
 *
 * The scenarios in `../fixtures` are the eight examples the spec works through,
 * written as data by an earlier card and deliberately carrying no expected
 * detection — so that a detector cannot be written to match the fixture instead
 * of to the requirement. What they do carry is the store's ordinary traffic
 * plus the rows that make each example what it is, and this file is the join:
 * it pools the searches into intents the same way the live scan does, builds the
 * inventory the store would hold, and hands the result to a detector unchanged.
 *
 * Test support, not production code — nothing outside a test imports it.
 */

/** The global thresholds, read lazily so importing this file costs nothing. */
export function rulesLayer(): RulesLayer {
  return rules().defaults
}

/** Every row a scenario contributes: the store's baseline traffic plus the example's own evidence. */
export function scenarioRows(id: number): SyntheticGscRow[] {
  const found = scenario(id)
  return [...found.store.gsc, ...found.gsc]
}

/** The rows inside one window, totalled per page and search the way the database returns them. */
export function totalsInWindow(
  rows: readonly SyntheticGscRow[],
  window: DetectionWindow,
): ClusterShareRow[] {
  const acc = new Map<string, { page: string; query: string; clicks: number; impressions: number; weight: number; base: number }>()
  for (const row of rows) {
    if (row.date < window.startDate) continue
    if (row.date > window.endDate) continue
    const key = `${row.page.length}:${row.page}${row.query}`
    const into = acc.get(key) ?? {
      page: row.page,
      query: row.query,
      clicks: 0,
      impressions: 0,
      weight: 0,
      base: 0,
    }
    into.clicks += row.clicks
    into.impressions += row.impressions
    if (row.impressions) {
      into.weight += row.position * row.impressions
      into.base += row.impressions
    }
    acc.set(key, into)
  }
  return [...acc.values()].map((row) => ({
    page: row.page,
    query: row.query,
    clicks: row.clicks,
    impressions: row.impressions,
    position: row.base ? row.weight / row.base : null,
  }))
}

/** The intents the store is shown for, built by the same code the weekly scan uses. */
export function clustersFrom(rows: readonly ClusterShareRow[]): ClusterDefinition[] {
  const byQuery = new Map<string, { query: string; clicks: number; impressions: number }>()
  for (const row of rows) {
    const into = byQuery.get(row.query) ?? { query: row.query, clicks: 0, impressions: 0 }
    into.clicks += row.clicks
    into.impressions += row.impressions
    byQuery.set(row.query, into)
  }
  return buildQueryClusters({ queries: [...byQuery.values()], config: rulesLayer().clusters }).map(
    (draft) => ({ headQuery: draft.headQuery, memberQueries: draft.memberQueries }),
  )
}

/**
 * The inventory the store would hold for these rows.
 *
 * Every address Search Console reported, typed from its shape — Shopify's
 * addresses are fixed, so `/collections/x` is a collection and
 * `/blogs/x/y` a blog article, which is exactly how the real inventory decides
 * it too. `intentClass` is null because nothing in the product writes that
 * column yet; a test that needs it supplies it.
 */
export function inventoryFor(
  rows: readonly ClusterShareRow[],
  intentClasses: Readonly<Record<string, PageFact['intentClass']>> = {},
): ReturnType<typeof indexPages> {
  const urls = [...new Set(rows.map((row) => row.page))].sort()
  return indexPages(
    urls.map((url) => ({
      url,
      pageType: pageTypeOf(url),
      intentClass: intentClasses[url] ?? null,
    })),
  )
}

function pageTypeOf(url: string): PageFact['pageType'] {
  if (url.startsWith('/collections/')) return 'collection'
  if (url.startsWith('/products/')) return 'product'
  if (url.startsWith('/blogs/')) return 'blog_article'
  if (url.startsWith('/pages/')) return 'page'
  return 'other'
}

/** A window of `days` ending on the day given. */
export function windowEndingOn(endDate: string, days: number): DetectionWindow {
  const end = new Date(`${endDate}T00:00:00Z`)
  const start = new Date(end.getTime())
  start.setUTCDate(start.getUTCDate() - (days - 1))
  return { startDate: start.toISOString().slice(0, 10), endDate, days }
}

/** The same window, some number of weeks earlier — how a "before" comparison is placed. */
export function shiftWeeks(window: DetectionWindow, weeks: number): DetectionWindow {
  const shift = (iso: string): string => {
    const date = new Date(`${iso}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() - weeks * 7)
    return date.toISOString().slice(0, 10)
  }
  return { startDate: shift(window.startDate), endDate: shift(window.endDate), days: window.days }
}

export const FETCHED_AT = '2026-01-29T06:00:00.000Z'

export type { SignalScenario }

/**
 * A synthetic product's attributes as a fact sheet.
 *
 * The fixture store predates distillation and describes a product with its own
 * loose attribute bag; the substance floor reads the ten-field sheet that
 * distillation produces. This is the join between them, and it is deliberately
 * conservative — an attribute with no home on the sheet is dropped rather than
 * squeezed into a field it does not belong in, because inflating a fixture
 * product's substance would make the floor look like it passes when it does
 * not.
 */
export function factSheetFor(product: SyntheticProduct): FactSheet {
  const fields = product.fields
  const list = (value: string | undefined): string[] => (value ? [value] : [])
  return {
    ...emptyFactSheet(),
    material: fields.material ?? null,
    weight: fields.weight_g ? `${fields.weight_g} g` : null,
    dimensions: fields.drop_mm ? `${fields.drop_mm} mm drop` : null,
    care: fields.care ?? null,
    use_cases_stated: list(fields.use_case),
    verifiable_claims: list(fields.waterproofing),
    fluff_discarded: product.style === 'fluff',
  }
}

/** Every product of one fixture family, ready for the substance floor. */
export function substanceInputFor(store: SyntheticStore, familyKey: string): ProductSubstance[] {
  return store.products
    .filter((product) => product.familyKey === familyKey)
    .map((product) => ({
      productId: product.id,
      title: product.title,
      familyId: familyKey,
      factSheet: factSheetFor(product),
    }))
}
