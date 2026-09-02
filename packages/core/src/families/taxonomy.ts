/**
 * The merchant's own filing of their catalogue, and which parts of it mean
 * something.
 *
 * A merchant who put forty products in "Trail Running Shoes" has told us they
 * are one kind of thing, and that statement is better evidence than any
 * similarity we could compute. But the same field also holds "Summer Sale",
 * "New Arrivals" and "Featured" — groupings by *when we are selling it*, not by
 * *what it is*. Grouping on those produces a family whose members have nothing
 * in common, and every article written from it is about nothing.
 *
 * So a taxonomy name is used only when it survives the blocklist below.
 */

/**
 * Word patterns that mark a grouping as promotional rather than categorical.
 *
 * Matched as whole words against the normalised name, so "Sale" is blocked and
 * "Wholesale Boots" is not. Deliberately conservative: a wrongly blocked name
 * costs us one grouping signal and the clustering below still runs, while a
 * wrongly kept one puts a sale banner on a comparison table.
 */
const PROMO_WORDS = [
  'sale',
  'sales',
  'clearance',
  'outlet',
  'discount',
  'discounted',
  'deal',
  'deals',
  'offer',
  'offers',
  'new',
  'newest',
  'arrival',
  'arrivals',
  'featured',
  'bestseller',
  'bestsellers',
  'seller',
  'sellers',
  'best',
  'popular',
  'trending',
  'seasonal',
  'summer',
  'winter',
  'spring',
  'autumn',
  'fall',
  'holiday',
  'christmas',
  'black',
  'friday',
  'cyber',
  'monday',
  'gift',
  'gifts',
  'bundle',
  'bundles',
  'last',
  'chance',
  'limited',
  'edition',
  'exclusive',
  'staff',
  'picks',
  'all',
  'shop',
  'home',
  'collection',
  'collections',
  'products',
  'catalog',
  'catalogue',
  'misc',
  'miscellaneous',
  'other',
  'others',
  'uncategorized',
  'uncategorised',
] as const

const PROMO_SET: ReadonlySet<string> = new Set(PROMO_WORDS)

/**
 * Whether a taxonomy name describes a promotion or a filing convention rather
 * than a kind of product.
 *
 * A name made *entirely* of blocked words is rejected; a name that merely
 * contains one is not. "Summer" and "New Arrivals" go; "Summer Dresses" and
 * "Gift Wrap" stay, because the remaining word is what the products are.
 */
export function isPromoTaxonomyName(name: string): boolean {
  const words = tokenize(name)
  if (words.length === 0) return true
  return words.every((word) => PROMO_SET.has(word))
}

/** One spelling per taxonomy name, so "Trail Running Shoes" and "trail running shoes" are one group. */
export function normalizeTaxonomyName(name: string): string {
  return tokenize(name).join(' ')
}

export interface TaxonomyCandidate {
  /** Shopify's `product_type`, the merchant's own name for what this is. */
  readonly productType?: string | null
}

/**
 * Which taxonomy group a product belongs to, or none.
 *
 * `product_type` is the only field read. **Collections are not**, and §6.4
 * calls them the primary candidate — but a product's collection membership is
 * not stored anywhere in this build: the catalogue sync does not fetch
 * collections, and the store-page inventory that does read them keeps the
 * families of a collection rather than its members, which would make this
 * circular even if it ran first. Recorded in DECISIONS; `product_type` is the
 * same kind of statement from the same merchant and is already in the row.
 */
export function taxonomyKeyFor(candidate: TaxonomyCandidate): string | null {
  const productType = candidate.productType?.trim()
  if (!productType) return null
  if (isPromoTaxonomyName(productType)) return null
  const normalized = normalizeTaxonomyName(productType)
  return normalized === '' ? null : normalized
}

/** A taxonomy key as a family name a merchant would recognise: "trail running shoes" → "Trail Running Shoes". */
export function taxonomyLabel(key: string): string {
  return key.replace(/\b[a-z]/g, (character) => character.toUpperCase())
}

function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '')
}
