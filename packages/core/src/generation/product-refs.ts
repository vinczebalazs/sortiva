/**
 * Volatile values — price, stock, sale status, product URL — never appear as
 * literal text in a draft. Founder decision, 2026-09-01 (`DECISIONS.md`,
 * card `T4.0`): the body carries a placeholder naming an `article_product_refs`
 * row instead, resolved from the live store at publish and every republish.
 * `docs/content-pointers.md` §9.
 */

export const PRODUCT_REF_FIELDS = ['price', 'stock', 'sale_status', 'url', 'title'] as const
export type ProductRefField = (typeof PRODUCT_REF_FIELDS)[number]

export const PRODUCT_REF_TYPES = ['link', 'recommendation', 'mention'] as const
export type ProductRefType = (typeof PRODUCT_REF_TYPES)[number]

/** One product the draft mentions, as the writer declares it — never a literal value. */
export interface DraftProductMention {
  /** Local id, e.g. `p1` — what `{{p1}}` in the prose resolves to. */
  readonly id: string
  readonly productId: string
  readonly refType: ProductRefType
  readonly fields: readonly ProductRefField[]
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

/** Every `{{id}}` placeholder token appearing in a piece of prose, in order, duplicates included. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!)
}

/**
 * A currency figure written as literal text — the thing a product-reference
 * placeholder exists to replace. Symbol-prefixed or -suffixed amounts
 * (`$49.99`, `49,99 €`) and amounts followed by a currency or ISO code
 * (`20 USD`, `49 kr`). Deliberately not anchored to one locale's number
 * format: a store's price appears in whatever format its currency uses, and
 * missing one is worse than an occasional false positive on an unrelated
 * number.
 */
const CURRENCY_SYMBOLS = '\\$€£¥'
const CURRENCY_CODES = 'USD|EUR|GBP|JPY|CHF|SEK|DKK|NOK|PLN|CZK|HUF|RON|CAD|AUD|kr|Kč|zł|Ft'
// A number with at most one decimal part, so a sentence-ending "." after the
// amount is never swept into the match — "$129.99." reports "$129.99", not
// "$129.99.".
const AMOUNT = '\\d[\\d,]*(?:\\.\\d+)?'
const CURRENCY_FIGURE = new RegExp(
  `[${CURRENCY_SYMBOLS}]\\s?${AMOUNT}|${AMOUNT}\\s?[${CURRENCY_SYMBOLS}]|${AMOUNT}\\s?(?:${CURRENCY_CODES})\\b`,
  'i',
)

export function containsCurrencyFigure(text: string): boolean {
  return CURRENCY_FIGURE.test(text)
}

/** Every distinct match, for a diagnostic message rather than a bare boolean. */
export function currencyFiguresIn(text: string): string[] {
  const re = new RegExp(CURRENCY_FIGURE, 'gi')
  return [...text.matchAll(re)].map((m) => m[0])
}
