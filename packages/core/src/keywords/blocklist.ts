/**
 * Domains that turn up at the top of almost every shopping search and are not
 * anybody's business competitor: marketplaces, encyclopaedias, social networks,
 * video and forum sites.
 *
 * They matter twice. Auto-detection would otherwise hand every merchant the
 * same five names, which is both useless and expensive — a competitor slot
 * spent on Amazon buys competitor keyword lookups for Amazon. And a merchant
 * typing one in by hand is warned rather than refused, because a shop that
 * genuinely competes with a marketplace exists and we are not the ones to tell
 * them they do not.
 *
 * Kept here rather than in `packages/rules`, which holds the numbers that
 * decide what we write about. This is a list of names, maintained by hand, and
 * adding one is a code change on purpose — the same posture the multi-tenant
 * suffix list takes.
 *
 * Entries are registrable domains, matched exactly or as a parent of the
 * candidate. `amazon` is listed under its country domains too, because
 * `amazon.de` and `amazon.co.uk` are separate registrable domains and a German
 * store's results page is full of the former.
 */

export const MARKETPLACE_BLOCKLIST: readonly string[] = [
  // Marketplaces and aggregators.
  'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es',
  'amazon.nl', 'amazon.se', 'amazon.pl', 'amazon.ca', 'amazon.com.au', 'amazon.com.br',
  'amazon.co.jp', 'amazon.in', 'amazon.ae', 'amazon.com.mx', 'amazon.sg',
  'etsy.com', 'ebay.com', 'ebay.co.uk', 'ebay.de', 'ebay.fr', 'ebay.it', 'ebay.es',
  'ebay.com.au', 'ebay.ca', 'aliexpress.com', 'alibaba.com', 'temu.com', 'wish.com',
  'walmart.com', 'target.com', 'otto.de', 'zalando.com', 'zalando.de', 'bol.com',
  'allegro.pl', 'cdiscount.com', 'fnac.com', 'mediamarkt.de', 'rakuten.com',
  'rakuten.co.jp', 'flipkart.com', 'shopee.com', 'lazada.com', 'mercadolibre.com',
  'wayfair.com', 'overstock.com', 'newegg.com', 'notonthehighstreet.com',
  'shop.app', 'google.com', 'shopping.google.com',

  // Reference, social, video and forums.
  'wikipedia.org', 'wikihow.com', 'quora.com', 'reddit.com', 'pinterest.com',
  'youtube.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'x.com',
  'twitter.com', 'linkedin.com', 'medium.com', 'tumblr.com', 'yelp.com',
  'tripadvisor.com', 'trustpilot.com',
]

const BLOCKED = new Set(MARKETPLACE_BLOCKLIST)

/**
 * True when a normalised domain is on the list, or is a subdomain of something
 * on it. The subdomain arm matters because a results page returns
 * `www.amazon.de` and `smile.amazon.com` as readily as the bare domain, and the
 * SERP reader hands us whatever the vendor reported.
 */
export function isBlocklistedDomain(domainNormalized: string): boolean {
  const host = domainNormalized.trim().toLowerCase().replace(/^www\./, '')
  if (host === '') return false
  if (BLOCKED.has(host)) return true
  for (const blocked of BLOCKED) {
    if (host.endsWith(`.${blocked}`)) return true
  }
  return false
}
