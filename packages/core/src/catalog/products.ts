import { createHash } from 'node:crypto'
import type { CatalogEvent } from '../contracts/opportunities'

/**
 * Turning a product as Shopify describes it into the row we keep, and working
 * out what actually changed when the same product comes round again.
 *
 * "What changed" matters more than it sounds. Re-reading a product's words costs
 * a model call, and a store fires a `products/update` every time somebody edits
 * a price or sells one of something. So the three kinds of change are told
 * apart here: the words moved, the price moved, or the stock moved. Only the
 * first is a reason for anything downstream to think again about what the
 * product *is*.
 */

/** A product as the Admin API hands it over. Only the fields we read are named. */
export interface ShopifyProduct {
  readonly id: number | string
  readonly title?: string
  readonly body_html?: string | null
  readonly handle?: string
  readonly product_type?: string | null
  readonly vendor?: string | null
  /** Shopify sends one comma-separated string, not a list. */
  readonly tags?: string | null
  readonly updated_at?: string | null
  readonly status?: string | null
  readonly variants?: readonly ShopifyVariant[]
  readonly images?: readonly { src?: string | null }[]
  /**
   * The merchant's own option definitions — "Size: S/M/L".
   *
   * Absent means the caller did not ask for them, which is not the same as the
   * product having none: writing "none" over options we already hold would lose
   * a store's best-organised data on the first read that forgot to ask.
   */
  readonly options?: readonly ShopifyOption[]
}

/** One option definition as the Admin API states it: an axis name and its values. */
export interface ShopifyOption {
  readonly name?: string | null
  readonly position?: number | null
  readonly values?: readonly (string | null)[] | null
}

export interface ShopifyVariant {
  readonly id?: number | string
  readonly title?: string | null
  readonly sku?: string | null
  readonly price?: string | number | null
  readonly compare_at_price?: string | number | null
  readonly inventory_quantity?: number | null
  readonly inventory_policy?: string | null
  readonly available?: boolean | null
}

/** One variant as we keep it: enough to compare prices and stock, and nothing else. */
export interface StoredVariant {
  readonly id: string
  readonly title: string | null
  readonly sku: string | null
  readonly price: number | null
  readonly compareAtPrice: number | null
  /** True when the store would let someone buy it right now. */
  readonly available: boolean
}

/**
 * One option axis as we keep it: the merchant's own name for a way their
 * products differ, and the values they gave it.
 *
 * This is the one place a store states an axis *by name*. Variant titles carry
 * the values — "Red", "Wide" — but never say what they are values of, so an
 * axis reconstructed from titles alone can only ever be called something we
 * invented. A comparison heading a merchant did not choose is worse than none.
 */
export interface ProductOption {
  readonly name: string
  readonly values: readonly string[]
}

/** One product, ready to be written. */
export interface ProductRow {
  readonly shopifyProductId: string
  readonly title: string
  readonly handle: string | null
  /** Quarantined: kept for display and debugging, never an input to anything we write. */
  readonly rawBodyHtml: string | null
  readonly productType: string | null
  readonly tags: readonly string[]
  readonly variants: readonly StoredVariant[]
  /**
   * Undefined when the description we were handed carried no option field at
   * all — a read that did not ask for them. An empty array means the store
   * really states none. The write path treats the two differently on purpose.
   */
  readonly options: readonly ProductOption[] | undefined
  readonly priceRange: { readonly min: number; readonly max: number; readonly currency?: string } | null
  /** Shopify's own last-modified stamp. */
  readonly updatedAt: Date | null
  /**
   * A fingerprint of the product's *words and attributes* — not its price and
   * not its stock. Distillation re-runs when this moves, so including a price
   * would buy a fresh model call every time a merchant ran a sale.
   */
  readonly checksum: string
}

export function toProductRow(product: ShopifyProduct): ProductRow {
  const variants = (product.variants ?? []).map(toStoredVariant)
  const prices = variants.map((v) => v.price).filter((p): p is number => p !== null)
  return {
    shopifyProductId: String(product.id),
    title: product.title ?? '',
    handle: product.handle ?? null,
    rawBodyHtml: product.body_html ?? null,
    productType: emptyToNull(product.product_type),
    tags: splitTags(product.tags),
    variants,
    options: toProductOptions(product.options),
    priceRange:
      prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
    updatedAt: parseDate(product.updated_at),
    checksum: productContentChecksum(product),
  }
}

/**
 * The option definitions, kept as the merchant wrote them.
 *
 * Nothing is renamed or lower-cased here: this is the store's own vocabulary
 * and the place it is shown to a merchant reads it back verbatim. Options with
 * no name are dropped — an axis with no name is not an axis — and so are the
 * duplicate names Shopify's own admin does not allow but its API does not
 * forbid, because two axes with one name would let the later one silently
 * replace the earlier one further downstream.
 */
export function toProductOptions(
  raw: readonly ShopifyOption[] | null | undefined,
): readonly ProductOption[] | undefined {
  if (raw === null || raw === undefined) return undefined
  const byName = new Map<string, ProductOption>()
  for (const option of raw) {
    const name = (option.name ?? '').trim()
    if (name === '') continue
    if (byName.has(name.toLowerCase())) continue
    const values = (option.values ?? [])
      .map((value) => (value ?? '').trim())
      .filter((value) => value !== '')
    byName.set(name.toLowerCase(), { name, values })
  }
  return [...byName.values()]
}

/**
 * Shopify's stand-in for "this product has no options at all".
 *
 * A product with nothing to choose still gets one option back from the API,
 * called `Title` with the single value `Default Title`, because every product
 * must have at least one variant and a variant must belong to an option. It
 * says nothing about the product. Left in, it would be an attribute every
 * product in every store shares and agrees on, which is exactly the shape that
 * makes two unrelated products look like the same thing.
 */
const SHOPIFY_PLACEHOLDER_OPTION = { name: 'title', value: 'default title' } as const

/**
 * The option axes that actually name something, placeholder removed.
 *
 * An option with no values is kept: a merchant who defined "Width" and has not
 * filled it in has still told us the axis exists, and the name is the half we
 * could not get anywhere else.
 */
export function namedOptionAxes(
  options: readonly ProductOption[] | null | undefined,
): readonly ProductOption[] {
  return (options ?? []).filter((option) => {
    const isPlaceholder =
      option.name.trim().toLowerCase() === SHOPIFY_PLACEHOLDER_OPTION.name &&
      option.values.length === 1 &&
      option.values[0]!.trim().toLowerCase() === SHOPIFY_PLACEHOLDER_OPTION.value
    return !isPlaceholder
  })
}

function toStoredVariant(variant: ShopifyVariant): StoredVariant {
  return {
    id: String(variant.id ?? ''),
    title: emptyToNull(variant.title),
    sku: emptyToNull(variant.sku),
    price: parseMoney(variant.price),
    compareAtPrice: parseMoney(variant.compare_at_price),
    available: isAvailable(variant),
  }
}

/**
 * Whether the store would sell one right now.
 *
 * A shop that lets customers order what it does not have in a warehouse
 * (`inventory_policy: continue`) is always available, whatever the count says —
 * treating that as out of stock would put a permanent repair flag on every
 * article referencing a made-to-order product.
 */
function isAvailable(variant: ShopifyVariant): boolean {
  if (typeof variant.available === 'boolean') return variant.available
  if (variant.inventory_policy === 'continue') return true
  return (variant.inventory_quantity ?? 0) > 0
}

/**
 * The fingerprint the drift sweep and the distillation cache both read.
 *
 * Deliberately covers only what a person could read on the page: the title, the
 * description, the type, the vendor, the tags, the address, the variant names
 * and codes, the images. Sorted, so Shopify reordering a list is not a change.
 */
export function productContentChecksum(product: ShopifyProduct): string {
  const material = {
    title: product.title ?? '',
    body: product.body_html ?? '',
    handle: product.handle ?? '',
    type: product.product_type ?? '',
    vendor: product.vendor ?? '',
    status: product.status ?? '',
    tags: splitTags(product.tags),
    variants: (product.variants ?? [])
      .map((v) => `${String(v.id ?? '')}|${v.title ?? ''}|${v.sku ?? ''}`)
      .sort(),
    images: (product.images ?? []).map((i) => i.src ?? '').sort(),
  }
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

/** The product's prices, as one comparable string. */
function priceSignature(variants: readonly StoredVariant[]): string {
  return variants
    .map((v) => `${v.id}:${v.price ?? ''}:${v.compareAtPrice ?? ''}`)
    .sort()
    .join(',')
}

/** Which of the product's variants can be bought, as one comparable string. */
function availabilitySignature(variants: readonly StoredVariant[]): string {
  return variants
    .map((v) => `${v.id}:${v.available ? '1' : '0'}`)
    .sort()
    .join(',')
}

/** What we already hold for a product, as the comparison needs it. */
export interface StoredProductState {
  readonly checksum: string | null
  readonly updatedAt: Date | null
  readonly variants: readonly StoredVariant[]
}

export type CatalogEventKind = CatalogEvent['kind']

/**
 * What changed between the product we hold and the one Shopify just described.
 *
 * Returns the kinds of change, not a single verdict, because one edit can be
 * two things at once — a merchant rewriting a description while dropping the
 * price is both, and the two have different consequences downstream.
 *
 * An empty answer means nothing we care about moved, which is the ordinary
 * result during a sweep and is what keeps the sweep cheap.
 */
export function classifyProductChange(
  stored: StoredProductState | undefined,
  incoming: ProductRow,
): readonly CatalogEventKind[] {
  if (!stored) return ['product_created']

  const kinds: CatalogEventKind[] = []
  if (stored.checksum !== incoming.checksum) kinds.push('product_updated')
  if (priceSignature(stored.variants) !== priceSignature(incoming.variants)) {
    kinds.push('price_changed')
  }
  if (availabilitySignature(stored.variants) !== availabilitySignature(incoming.variants)) {
    kinds.push('availability_changed')
  }
  return kinds
}

/**
 * Whether an arriving description of a product is older than the one we hold.
 *
 * Shopify delivers webhooks out of order as a matter of course, so without this
 * a redelivered edit from ten minutes ago can overwrite the edit from one
 * minute ago and the store's own admin and our copy disagree until the nightly
 * sweep repairs it.
 */
export function isStaleUpdate(
  storedUpdatedAt: Date | null | undefined,
  incomingUpdatedAt: Date | null | undefined,
): boolean {
  if (!storedUpdatedAt || !incomingUpdatedAt) return false
  return incomingUpdatedAt.getTime() < storedUpdatedAt.getTime()
}

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at
}

function parseMoney(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const amount = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(amount) ? amount : null
}

function splitTags(tags: string | null | undefined): readonly string[] {
  if (!tags) return []
  return tags
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === '' ? null : value
}
