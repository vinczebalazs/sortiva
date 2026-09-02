import type { GatesConfig } from '@sortiva/rules'
import { EXTRACTED_FIELDS, type FactSheet, countPopulatedFields } from '../distill/schema'

/**
 * Do we know enough about what the store sells to write something worth
 * reading?
 *
 * The measure counts *facts*, never words. A four-hundred-word description that
 * distils to "it is made of leather" knows one thing about the product, and
 * forty near-identical listings are one subject rather than forty sources — so
 * neither padding nor a large catalogue can talk its way past this. It is the
 * difference between an article that tells a shopper something and an article
 * that rearranges adjectives, and it is checked before anything is written
 * rather than discovered afterwards.
 *
 * Three numbers, all in `packages/rules`: how well described a single product
 * has to be before it counts as a source at all, how many such products have to
 * contribute, and how many distinct facts they have to amount to between them.
 */

/** The ten fields a product's description can support, as the fact sheet holds them. */
export type ProductField = (typeof EXTRACTED_FIELDS)[number]

export interface ProductSubstance {
  readonly productId: string
  readonly title: string
  readonly familyId: string
  readonly factSheet: FactSheet
}

/** One product that is not pulling its weight, and exactly what it is missing. */
export interface ProductShortfall {
  readonly productId: string
  readonly title: string
  readonly familyId: string
  readonly populatedFields: number
  /** Which of the ten the description never supported — the merchant's task, written out. */
  readonly missingFields: readonly ProductField[]
}

export interface SubstanceInventory {
  readonly familyIds: readonly string[]
  /** Distinct facts across every product that counted as a source. */
  readonly distinctFacts: number
  readonly contributingProducts: number
  readonly productsConsidered: number
  readonly passes: boolean
  /** Clears the floor by the margin that reads as "plenty to say" rather than "just enough". */
  readonly clearsWithMargin: boolean
  /** Every product below the per-product floor, worst first. Empty when the floor is cleared comfortably. */
  readonly shortfalls: readonly ProductShortfall[]
}

function isPopulated(value: FactSheet[ProductField]): boolean {
  if (Array.isArray(value)) return value.some((entry) => entry.trim() !== '')
  return typeof value === 'string' && value.trim() !== ''
}

function missingFieldsOf(sheet: FactSheet): ProductField[] {
  return EXTRACTED_FIELDS.filter((field) => !isPopulated(sheet[field]))
}

/**
 * Every separate thing the contributing products state, counted once.
 *
 * A fact is a field and its value together: two products both made of leather
 * know the same thing, and counting it twice would let a shelf of clones look
 * like a deep catalogue. Each entry of a list counts separately, because three
 * stated uses are three things we could write about.
 */
function distinctFactsOf(products: readonly ProductSubstance[]): Set<string> {
  const seen = new Set<string>()
  for (const product of products) {
    for (const field of EXTRACTED_FIELDS) {
      const value = product.factSheet[field]
      if (Array.isArray(value)) {
        for (const entry of value) if (entry.trim() !== '') seen.add(`${field}=${entry.trim()}`)
      } else if (typeof value === 'string' && value.trim() !== '') {
        seen.add(`${field}=${value.trim()}`)
      }
    }
  }
  return seen
}

/**
 * Runs the floor over the products of one or more families.
 *
 * Families rather than products because that is the unit everything downstream
 * works in: a buying guide covers a family, so what matters is whether the
 * family's members between them state enough to fill one.
 */
export function substanceInventory(
  products: readonly ProductSubstance[],
  config: GatesConfig['substance_floor'],
): SubstanceInventory {
  const contributing = products.filter(
    (product) =>
      countPopulatedFields(product.factSheet) >= config.populated_fields_per_product_min,
  )
  const distinctFacts = distinctFactsOf(contributing).size

  const passes =
    distinctFacts >= config.distinct_facts_min &&
    contributing.length >= config.contributing_products_min

  const clearsWithMargin =
    distinctFacts >= config.distinct_facts_min * config.margin_multiple &&
    contributing.length >= config.contributing_products_min * config.margin_multiple

  const contributingIds = new Set(contributing.map((product) => product.productId))
  const shortfalls = products
    .filter((product) => !contributingIds.has(product.productId))
    .map((product) => ({
      productId: product.productId,
      title: product.title,
      familyId: product.familyId,
      populatedFields: countPopulatedFields(product.factSheet),
      missingFields: missingFieldsOf(product.factSheet),
    }))
    .sort((a, b) => a.populatedFields - b.populatedFields || a.productId.localeCompare(b.productId))

  return {
    familyIds: [...new Set(products.map((product) => product.familyId))].sort(),
    distinctFacts,
    contributingProducts: contributing.length,
    productsConsidered: products.length,
    passes,
    clearsWithMargin,
    shortfalls,
  }
}
