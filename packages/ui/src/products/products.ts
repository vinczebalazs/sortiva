import { t as defaultTranslate, type StringKey, type Translate } from '../strings'
import type { MerchantTask, ProductRow, RichnessBand, TaskProduct } from './types'

/**
 * What the Products screen decides before anything is drawn: which tasks are
 * still open, which products are thin, what a missing field is called, and
 * whether a link we were handed is safe to put in front of a merchant.
 *
 * The last of those is the one worth reading twice. Every product on a task card
 * carries a deep link into Shopify admin, and that address arrives from the API
 * rather than being built here. An address on some other host — through a bug,
 * or through a value that reached us from outside — would be an invitation from
 * our own screen to somewhere we did not mean to send anybody, so a link that is
 * not an HTTPS Shopify admin address is dropped and the product renders as a
 * plain row instead.
 */

export function richnessLabel(band: RichnessBand, t: Translate = defaultTranslate): string {
  return t(`products.richness.${band}` as StringKey)
}

/**
 * A missing field in the merchant's words. The engine names fields the way it
 * stores them (`lug_depth`, `weight_g`), and a new one arriving before its
 * wording does is a real possibility, so an unknown name is spelled out rather
 * than shown as a code.
 *
 * Lower case throughout, because every one of these is read inside a sentence
 * fragment — "missing: drop, lug depth" — rather than standing on its own.
 */
export function fieldLabel(field: string, t: Translate = defaultTranslate): string {
  try {
    return t(`products.field.${field}` as StringKey)
  } catch {
    return field
      .replace(/_g$/, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .trim()
  }
}

export interface SplitTasks {
  readonly open: readonly MerchantTask[]
  readonly completed: readonly MerchantTask[]
}

/**
 * Open tasks lead the screen; completed ones fold away with the date they were
 * done. A cleared checklist left on screen turns a page about what to do next
 * into a page about what is already finished.
 */
export function splitTasks(tasks: readonly MerchantTask[]): SplitTasks {
  return {
    open: tasks.filter((task) => task.completedAt === null),
    completed: tasks.filter((task) => task.completedAt !== null),
  }
}

/** Every product named across the open tasks, without repeating one that blocks two. */
export function productsAwaitingDetails(tasks: readonly MerchantTask[]): readonly TaskProduct[] {
  const seen = new Map<string, TaskProduct>()
  for (const task of tasks) {
    for (const product of task.products) {
      if (!seen.has(product.id)) seen.set(product.id, product)
    }
  }
  return [...seen.values()]
}

/**
 * Whether a deep link is one we are willing to render.
 *
 * Shopify admin lives on `*.myshopify.com/admin/…` or `admin.shopify.com/…`.
 * Anything else — another host, a `javascript:` address, a plain-HTTP one — is
 * refused rather than sanitised, because a link that has to be repaired before
 * it is safe is a link nobody should be following.
 */
export function isShopifyAdminUrl(raw: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  return host === 'admin.shopify.com' || host.endsWith('.myshopify.com')
}

export type ProductFilter = 'all' | 'sparse'

/**
 * The sparse filter is the only one on the table, and it answers the question
 * the screen exists for: which products do we not know enough about to write
 * anything worth reading?
 */
export function filterProducts(
  products: readonly ProductRow[],
  filter: ProductFilter,
): readonly ProductRow[] {
  if (filter === 'all') return products
  return products.filter((product) => product.richnessBand === 'sparse')
}

/** The missing-field summary under a product's title, or null when nothing is missing. */
export function missingSummary(
  product: ProductRow,
  t: Translate = defaultTranslate,
): string | null {
  if (product.missingFields.length === 0) return null
  return t('products.table.missing', {
    fields: product.missingFields.map((field) => fieldLabel(field, t)).join(', '),
  })
}
