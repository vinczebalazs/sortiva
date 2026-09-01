import { intBetween, pick, positionAround, seededRandom } from './random'

/**
 * The synthetic-store generator (build plan T0.6): a catalog of fluff and
 * spec-heavy products, the families they group into, and GSC page × query rows —
 * all deterministic from a seed.
 *
 * Why both kinds of product: distillation extracts *facts*, not marketing copy,
 * and the substance floor holds a topic back when the catalog behind it is
 * fluff. A fixture store made only of well-specified products cannot exercise
 * either rule, and scenario 7 ("catalog richness gap → HOLD") has nothing to
 * detect.
 *
 * These shapes are **fixture shapes**, not the wave-2 `products` /
 * `product_facts` / `gsc_query_daily` schema, which does not exist yet. The
 * cards that add those tables map from here; keeping the fixture independent is
 * what lets it be written before the schema (DECISIONS 2026-08-31 T0.6).
 */

export type ProductStyle = 'spec' | 'fluff'

export interface SyntheticProduct {
  readonly id: string
  readonly handle: string
  readonly title: string
  readonly familyKey: string
  /** `spec` products carry populated fields; `fluff` products carry marketing prose. */
  readonly style: ProductStyle
  readonly bodyHtml: string
  /** Attribute name to value. The substance floor counts how many of these are populated per product. */
  readonly fields: Readonly<Record<string, string>>
  readonly priceMinorUnits: number
  readonly collections: readonly string[]
  readonly updatedAt: string
}

export interface SyntheticFamily {
  readonly key: string
  readonly label: string
  /** What distinguishes members of the family from one another. */
  readonly axes: readonly string[]
  readonly memberIds: readonly string[]
}

/** One row of the page-by-query performance table Search Console returns. */
export interface SyntheticGscRow {
  readonly page: string
  readonly query: string
  readonly impressions: number
  readonly clicks: number
  readonly position: number
  /** ISO date of the day the row covers. */
  readonly date: string
}

export interface SyntheticStore {
  readonly domain: string
  readonly locale: { readonly languageCode: string; readonly countryCode: string }
  readonly products: readonly SyntheticProduct[]
  readonly families: readonly SyntheticFamily[]
  readonly gsc: readonly SyntheticGscRow[]
  readonly pages: readonly string[]
}

export interface SyntheticStoreOptions {
  seed?: number
  domain?: string
  languageCode?: string
  countryCode?: string
  /** Family key → how many products it holds. */
  families?: Readonly<Record<string, number>>
  /** Fraction of products written as marketing fluff. */
  fluffShare?: number
  /** First day covered by the GSC rows; rows run forward from here. */
  startDate?: string
}

const DEFAULT_FAMILIES: Record<string, number> = {
  'trail-running': 12,
  road_running: 10,
  hiking_boots: 9,
  trail_apparel: 9,
}

const FAMILY_AXES: Record<string, string[]> = {
  'trail-running': ['terrain', 'drop', 'width'],
  road_running: ['cushioning', 'drop', 'width'],
  hiking_boots: ['waterproofing', 'ankle_height', 'width'],
  trail_apparel: ['weight', 'weather', 'fit'],
}

const SPEC_FIELDS: Record<string, string[]> = {
  material: ['recycled ripstop nylon', 'full-grain leather', 'engineered mesh', 'merino wool'],
  weight_g: ['218', '265', '312', '405'],
  waterproofing: ['GORE-TEX', 'DWR-treated', 'none'],
  drop_mm: ['4', '6', '8', '10'],
  width: ['standard', 'wide', 'narrow'],
  use_case: ['technical trail', 'gravel and fire road', 'multi-day trekking', 'daily training'],
  care: ['machine wash cold, hang dry', 'wipe clean, air dry'],
}

const FLUFF_SENTENCES = [
  'Engineered for those who refuse to settle.',
  'Where performance meets everyday comfort.',
  'Our most-loved silhouette, reimagined for the season.',
  'Designed in the mountains. Made for everywhere.',
  'A staple you will reach for again and again.',
]

/**
 * Same seed, same store — asserted by the fixture suite. Nothing here reads the
 * clock or `Math.random()`.
 */
export function generateSyntheticStore(options: SyntheticStoreOptions = {}): SyntheticStore {
  const seed = options.seed ?? 1
  const random = seededRandom(seed)
  const families = options.families ?? DEFAULT_FAMILIES
  const fluffShare = options.fluffShare ?? 0.35
  const startDate = options.startDate ?? '2026-01-01'

  const products: SyntheticProduct[] = []
  const familyRows: SyntheticFamily[] = []

  for (const [familyKey, count] of Object.entries(families)) {
    const memberIds: string[] = []
    for (let index = 0; index < count; index += 1) {
      const style: ProductStyle = random() < fluffShare ? 'fluff' : 'spec'
      const id = `${familyKey}-${index + 1}`
      const title = `${titleCase(familyKey)} ${index + 1}`
      memberIds.push(id)
      products.push({
        id,
        handle: `${familyKey.replace(/_/g, '-')}-${index + 1}`,
        title,
        familyKey,
        style,
        bodyHtml:
          style === 'fluff'
            ? `<p>${pick(random, FLUFF_SENTENCES)} ${pick(random, FLUFF_SENTENCES)}</p>`
            : `<p>${title}. ${describeSpecs(random)}</p>`,
        fields: style === 'fluff' ? sparseFields(random) : specFields(random),
        priceMinorUnits: intBetween(random, 4900, 24900),
        collections: [familyKey.replace(/_/g, '-')],
        updatedAt: dayOffset(startDate, intBetween(random, 0, 60)),
      })
    }
    familyRows.push({
      key: familyKey,
      label: titleCase(familyKey),
      axes: FAMILY_AXES[familyKey] ?? ['variant'],
      memberIds,
    })
  }

  const pages = familyRows.map((f) => `/collections/${f.key.replace(/_/g, '-')}`)

  const gsc: SyntheticGscRow[] = []
  for (const page of pages) {
    const family = page.replace('/collections/', '').replace(/-/g, ' ')
    for (const suffix of ['', ' for beginners', ' best', ' review']) {
      gsc.push({
        page,
        query: `${family}${suffix}`.trim(),
        impressions: intBetween(random, 40, 4000),
        clicks: intBetween(random, 0, 120),
        position: positionAround(random, intBetween(random, 3, 30), 2),
        date: startDate,
      })
    }
  }

  return {
    domain: options.domain ?? 'example-outdoor.com',
    locale: {
      languageCode: options.languageCode ?? 'en',
      countryCode: options.countryCode ?? 'GB',
    },
    products,
    families: familyRows,
    gsc,
    pages,
  }
}

/**
 * The substance floor counts distinct facts across contributing products, each
 * needing enough populated fields. Exposed so a fixture can be
 * checked against the floor without re-deriving how to count.
 */
export function countSubstance(
  products: readonly SyntheticProduct[],
  minPopulatedFieldsPerProduct: number,
): { distinctFacts: number; contributingProducts: number } {
  const contributing = products.filter(
    (p) => Object.keys(p.fields).length >= minPopulatedFieldsPerProduct,
  )
  const facts = new Set<string>()
  for (const product of contributing) {
    for (const [key, value] of Object.entries(product.fields)) facts.add(`${key}=${value}`)
  }
  return { distinctFacts: facts.size, contributingProducts: contributing.length }
}

function specFields(random: () => number): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [field, values] of Object.entries(SPEC_FIELDS)) {
    out[field] = pick(random, values)
  }
  return out
}

/** Fluff products carry at most one real attribute — that is what makes them fluff. */
function sparseFields(random: () => number): Record<string, string> {
  return random() < 0.5 ? {} : { material: pick(random, SPEC_FIELDS.material!) }
}

function describeSpecs(random: () => number): string {
  return [
    `Upper in ${pick(random, SPEC_FIELDS.material!)}.`,
    `Weighs ${pick(random, SPEC_FIELDS.weight_g!)} g.`,
    `Heel-to-toe drop ${pick(random, SPEC_FIELDS.drop_mm!)} mm.`,
    `Built for ${pick(random, SPEC_FIELDS.use_case!)}.`,
  ].join(' ')
}

function titleCase(key: string): string {
  return key
    .replace(/[-_]/g, ' ')
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

export function dayOffset(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
