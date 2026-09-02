/**
 * Telling a store's own name apart from everything else people search for.
 *
 * Someone searching the store by name was going to click it whatever the
 * listing said. Leaving those searches in flatters the click curve badly — a
 * brand search often converts at several times the rate of anything else at the
 * same position — and a flattered curve then makes every ordinary page look
 * under-clicked by comparison. So the curve is fitted with them removed, and
 * `ctr_curve.branded_excluded` records whether that was possible.
 *
 * We have no field anywhere that holds a merchant's brand name. What we do have
 * is the address they claimed and, for a Shopify store, the name Shopify knows
 * them by. Both are chosen by the merchant and both are the brand far more often
 * than not. Where neither yields a usable word, the fit says so rather than
 * pretending: excluding nothing is honest, and guessing a brand token wrongly
 * would silently throw away real searches.
 */

/**
 * Words that are somebody's brand roughly never, and that appear inside store
 * addresses constantly. A token this generic would match a large share of every
 * store's ordinary searches, and removing those from the fit is the failure this
 * list exists to prevent.
 */
const NOT_A_BRAND = new Set([
  'shop',
  'store',
  'shops',
  'stores',
  'online',
  'the',
  'my',
  'buy',
  'web',
  'www',
  'official',
  'group',
  'company',
  'co',
  'ltd',
  'inc',
  'bv',
  'gmbh',
])

/** Below this a token matches too much to be anybody's name — "hm" would strip half a catalogue's searches. */
const MIN_BRAND_TOKEN_LENGTH = 3

export interface BrandTokenSources {
  /** The registrable domain the merchant claimed, e.g. `nordic-socks.dk`. */
  readonly domainNormalized?: string | null
  /** The store's Shopify name, e.g. `nordic-socks` or `nordic-socks.myshopify.com`. */
  readonly shopHandle?: string | null
}

function tokenise(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/\.myshopify\.com$/, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/**
 * The words that stand a real chance of being this store's name.
 *
 * A domain is split on its separators because merchants hyphenate compound
 * brands, and both halves of "nordic-socks" are worth matching on their own —
 * people search "nordic socks", "nordicsocks" and "socks nordic" for the same
 * shop. The joined form is kept too, so "nordicsocks" as one word still matches.
 */
export function brandTokens(sources: BrandTokenSources): string[] {
  const found = new Set<string>()

  for (const raw of [sources.domainNormalized, sources.shopHandle]) {
    if (!raw) continue
    const parts = tokenise(raw)
    // The last part of a domain is its suffix (`dk`, `com`), never the brand.
    const withoutSuffix = raw.includes('.') && parts.length > 1 ? parts.slice(0, -1) : parts
    if (withoutSuffix.length === 0) continue

    const joined = withoutSuffix.join('')
    if (joined.length >= MIN_BRAND_TOKEN_LENGTH && !NOT_A_BRAND.has(joined)) found.add(joined)

    for (const part of withoutSuffix) {
      if (part.length < MIN_BRAND_TOKEN_LENGTH) continue
      if (NOT_A_BRAND.has(part)) continue
      found.add(part)
    }
  }

  return [...found].sort()
}

/**
 * Whether a search looks like somebody looking for this store by name.
 *
 * Matched on whole words rather than as a substring: a store called `ora` must
 * not swallow every search containing "decoration". The joined form is the one
 * exception — "nordicsocks" is one word to a searcher — and it is only ever
 * produced from a domain the merchant themselves chose.
 */
export function isBrandedQuery(query: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false
  const words = new Set(tokenise(query))
  if (words.size === 0) return false
  for (const token of tokens) {
    if (words.has(token)) return true
  }
  const squashed = [...words].join('')
  return tokens.some((token) => token.length >= MIN_BRAND_TOKEN_LENGTH && squashed === token)
}
