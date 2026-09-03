import type { ProductRefField, ProductRefType } from '../generation/product-refs'

/**
 * Turning the placeholders in a finished draft into the values a reader sees.
 *
 * A draft never contains a price, a stock state or a product address as text.
 * It contains a marker — `{{p1}}` — naming a reference row, and this is where
 * that marker becomes words. The values come from the store as it is *now*, at
 * the moment the article is being handed over, so a merchant who changed a
 * price this morning downloads this morning's price rather than the one that
 * was true when the article was written weeks ago.
 *
 * The consequence that matters: a reference whose product has gone is not
 * rendered as a blank or a leftover marker. It is reported, and the caller
 * refuses to produce the article at all — a hole in a published page is worse
 * than a download that says why it did not happen.
 */

/** One placeholder in the body, as `article_product_refs` records it. */
export interface ProductReference {
  /** The marker's own name — `p1` for `{{p1}}`. */
  readonly placeholderKey: string
  /** Null when the product row is gone; the reference row deliberately survives it. */
  readonly productId: string | null
  readonly refType: ProductRefType
  /** Which volatile values this mention promised to show. */
  readonly fieldsRendered: readonly ProductRefField[]
}

/** A product as the store sells it at this moment. Every field is read fresh; none is remembered. */
export interface LiveProduct {
  readonly productId: string
  readonly title: string
  /** The lowest current price across the product's variants, or null when the store lists none. */
  readonly price: number | null
  /** Shopify's "was" price, where one is set and higher than the current one. */
  readonly compareAtPrice: number | null
  readonly available: boolean
  /** ISO currency code where the store's rows carry one. */
  readonly currency: string | null
  /** The address this product is sold at, from the store's own content inventory. */
  readonly url: string | null
}

export interface ResolvedReference {
  readonly placeholderKey: string
  /** One entry per field the mention promised — what the reader is shown, as text. */
  readonly values: Readonly<Record<string, string>>
  /** The mention rendered for a Markdown body. */
  readonly markdown: string
  /** The same mention rendered for an HTML body. */
  readonly html: string
}

export interface ResolutionResult {
  readonly resolved: ReadonlyMap<string, ResolvedReference>
  /**
   * Placeholders whose product could not be found in the store any more. A
   * non-empty list means the article cannot be handed over as it stands.
   */
  readonly missing: readonly string[]
}

/**
 * A price as a reader would see it.
 *
 * The currency is printed when the store's rows carry one and omitted when they
 * do not, rather than guessed from the merchant's country — a shop in Germany
 * selling in dollars is ordinary, and a wrong currency symbol on a price is a
 * worse error than a missing one.
 */
export function formatPrice(amount: number, currency: string | null): string {
  const figure = amount.toFixed(2)
  return currency ? `${figure} ${currency}` : figure
}

function valuesFor(
  reference: ProductReference,
  product: LiveProduct,
): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of reference.fieldsRendered) {
    switch (field) {
      case 'title':
        values.title = product.title
        break
      case 'url':
        if (product.url) values.url = product.url
        break
      case 'price':
        if (product.price !== null) values.price = formatPrice(product.price, product.currency)
        break
      case 'stock':
        values.stock = product.available ? 'in stock' : 'out of stock'
        break
      case 'sale_status':
        values.sale_status =
          product.compareAtPrice !== null && product.price !== null && product.compareAtPrice > product.price
            ? 'on sale'
            : 'not on sale'
        break
    }
  }
  return values
}

const PHRASE_EXTRAS = ['price', 'sale_status', 'stock'] as const

/**
 * What a mention reads as in the sentence around it.
 *
 * The product's name is always the spine of it — the writer's prose is built
 * around a noun phrase, so a mention that rendered as a bare price would leave
 * a sentence that does not parse. Anything else the mention promised follows in
 * brackets.
 */
function phraseFor(product: LiveProduct, values: Record<string, string>): string {
  const extras = PHRASE_EXTRAS.map((field) => values[field]).filter(
    (value): value is string => value !== undefined,
  )
  return extras.length > 0 ? `${product.title} (${extras.join(', ')})` : product.title
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function resolveProductReferences(
  references: readonly ProductReference[],
  live: ReadonlyMap<string, LiveProduct>,
): ResolutionResult {
  const resolved = new Map<string, ResolvedReference>()
  const missing: string[] = []

  for (const reference of references) {
    const product = reference.productId ? live.get(reference.productId) : undefined
    if (!product) {
      missing.push(reference.placeholderKey)
      continue
    }
    const values = valuesFor(reference, product)
    const phrase = phraseFor(product, values)
    const link = values.url ?? product.url
    resolved.set(reference.placeholderKey, {
      placeholderKey: reference.placeholderKey,
      values,
      markdown: link ? `[${phrase}](${link})` : phrase,
      html: link
        ? `<a href="${escapeHtml(link)}">${escapeHtml(phrase)}</a>`
        : escapeHtml(phrase),
    })
  }

  return { resolved, missing }
}

/**
 * A placeholder left in the body after resolution — the thing that must never
 * reach a reader. Named separately from the missing-product case because they
 * have different causes: a product that has gone, and a marker the writer put
 * in the prose without declaring a mention for it.
 */
export function unresolvedPlaceholders(
  text: string,
  resolved: ReadonlyMap<string, ResolvedReference>,
): readonly string[] {
  const found = [...text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((match) => match[1] as string)
  return [...new Set(found.filter((key) => !resolved.has(key)))]
}

/** Replaces every `{{key}}` marker with the rendered mention, in the format asked for. */
export function renderPlaceholders(
  text: string,
  resolved: ReadonlyMap<string, ResolvedReference>,
  format: 'markdown' | 'html',
): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, key: string) => {
    const reference = resolved.get(key)
    if (!reference) return whole
    return format === 'markdown' ? reference.markdown : reference.html
  })
}
