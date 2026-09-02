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
    priceRange:
      prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
    updatedAt: parseDate(product.updated_at),
    checksum: productContentChecksum(product),
  }
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
