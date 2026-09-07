import { toProductMetafields, type ProductMetafield, type ShopifyMetafield } from '@sortiva/core'
import type { ShopifyListReader } from './deps'

/**
 * Reading one product's metafields — the structured attributes a merchant fills
 * in when their products differ by things Shopify has no field for.
 *
 * It is a request of its own, and that is the whole reason this is a separate
 * file rather than another line in the catalogue walk. A product's options,
 * tags, type and variants all arrive with the product; its metafields never do,
 * in any version of the Admin REST API. So reading them for a store of five
 * hundred products is five hundred extra requests at the store's paced rate,
 * and the walks that call this ask only for the products they have just learned
 * about or seen change.
 */

/** Shopify's ceiling on a list request, and far more metafields than a product has. */
const PAGE_SIZE = 250

/**
 * How many pages of metafields we will read for one product before stopping.
 *
 * Two hundred and fifty is already past what a real product carries. The cap
 * exists because the loop follows a cursor that comes from someone else's
 * server, and a loop with no ceiling is a loop that can be made not to end.
 */
const MAX_PAGES = 4

/**
 * What we hold for one product's metafields, or `undefined` when the read did
 * not happen. The two are different all the way to the database: undefined
 * leaves the stored value alone, where an empty list would overwrite it.
 */
export type MetafieldReadResult = readonly ProductMetafield[] | undefined

/**
 * One product's metafields.
 *
 * A failure here is not a failure of the walk. The product itself has already
 * been read and is about to be written; its metafields are an enrichment, and a
 * store that deleted a product between the list read and this one would
 * otherwise take its whole catalogue sync down with it. So anything that is not
 * a dead token is reported as "not read" — which leaves whatever we already
 * hold untouched rather than replacing it with nothing — and the next sync asks
 * again.
 */
export async function readProductMetafields(
  admin: ShopifyListReader,
  auth: { shop: string; accessToken: string },
  shopifyProductId: string,
  onSkip?: (reason: string) => void,
): Promise<MetafieldReadResult> {
  const collected: ShopifyMetafield[] = []
  let cursor: string | undefined

  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const path = cursor
        ? `products/${encodeURIComponent(shopifyProductId)}/metafields.json` +
          `?limit=${PAGE_SIZE}&page_info=${encodeURIComponent(cursor)}`
        : `products/${encodeURIComponent(shopifyProductId)}/metafields.json?limit=${PAGE_SIZE}`
      const answer = await admin.getPage<{ metafields?: ShopifyMetafield[] }>(auth, path)
      collected.push(...(answer.body.metafields ?? []))
      cursor = answer.nextPageInfo
      if (!cursor) break
    }
  } catch (error) {
    // A dead token is the store's problem and not this product's: it routes the
    // merchant to the reconnect screen, and swallowing it here would leave the
    // walk grinding through a catalogue it can no longer read.
    if (isTokenInvalid(error)) throw error
    onSkip?.(error instanceof Error ? error.message : 'the metafield read failed')
    return undefined
  }

  return toProductMetafields(collected)
}

function isTokenInvalid(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { errorClass?: unknown }).errorClass === 'shopify_token_invalid'
  )
}
