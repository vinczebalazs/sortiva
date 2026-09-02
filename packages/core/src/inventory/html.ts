/**
 * Pulling the two structural facts we need out of a page's markup: what it says
 * in its headings, and which of the store's own pages it links to.
 *
 * This reads markup the store handed us. It never fetches anything, and it must
 * not start to: the inventory exists precisely so that the rest of the product
 * can reason about a store's pages without a crawler.
 *
 * Regexes rather than a parser because the input is one field of an admin API
 * response, we want exactly two things out of it, and adding an HTML parser to
 * the dependency-free domain package to read `<h2>` would cost more than it
 * saves. The failure mode is benign: markup we mis-read yields a heading or a
 * link we miss, never a wrong conclusion — nothing in V1 draws an inference from
 * the *absence* of a link.
 */

const HEADING = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi
const ANCHOR_HREF = /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>/gi

/** Entities that actually turn up in merchant copy. Anything else is left as written. */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#?\w+);/g, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/**
 * The page's headings, top to bottom, in the order they appear.
 *
 * Order is the point: the coverage analysis compares this sequence against what
 * the pages already ranking cover, and a set would lose the shape of the
 * argument.
 */
export function extractHeadings(bodyHtml: string | null | undefined): string[] {
  if (!bodyHtml) return []
  const out: string[] = []
  for (const match of bodyHtml.matchAll(HEADING)) {
    const text = stripTags(match[2] ?? '')
    if (text.length > 0) out.push(text)
  }
  return out
}

/**
 * Links from this page to other pages of the same store, as absolute addresses.
 *
 * Absolute and normalised so they join against the `url` column of the other
 * inventory rows — a link graph whose two sides spell the same page differently
 * is not a graph. Addresses off the store's own site, anchors, `mailto:` and
 * the like are dropped: this is the internal link graph, not an outbound one.
 *
 * Known blind spot, and it is deliberate: links that live in the theme's
 * navigation are not in the page body and so are not here. That is why nothing
 * in V1 concludes anything from a link being missing.
 */
export function extractInternalLinks(
  bodyHtml: string | null | undefined,
  storefrontOrigin: string,
): string[] {
  if (!bodyHtml) return []
  const origin = normaliseOrigin(storefrontOrigin)
  const seen = new Set<string>()
  for (const match of bodyHtml.matchAll(ANCHOR_HREF)) {
    const raw = (match[2] ?? match[3] ?? match[4] ?? '').trim()
    if (raw === '') continue
    const absolute = toInternalUrl(raw, origin)
    if (absolute) seen.add(absolute)
  }
  return [...seen]
}

/** `https://shop.example` — scheme kept, trailing slash and any path dropped. */
export function normaliseOrigin(storefrontOrigin: string): string {
  const withScheme = /^https?:\/\//i.test(storefrontOrigin)
    ? storefrontOrigin
    : `https://${storefrontOrigin}`
  const url = new URL(withScheme)
  return `${url.protocol}//${url.host}`.toLowerCase()
}

/**
 * One store address, spelled one way.
 *
 * The query string and fragment go: `/collections/boots?sort=price` and
 * `/collections/boots` are the same page, and keeping both would put the same
 * page in the inventory twice under a unique index that forbids it. The
 * trailing slash goes for the same reason.
 */
export function canonicalStoreUrl(path: string, storefrontOrigin: string): string {
  const origin = normaliseOrigin(storefrontOrigin)
  const url = new URL(path, `${origin}/`)
  url.search = ''
  url.hash = ''
  const pathname = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host.toLowerCase()}${pathname}`
}

function toInternalUrl(href: string, origin: string): string | undefined {
  if (href.startsWith('#')) return undefined
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^https?:/i.test(href)) return undefined
  let url: URL
  try {
    url = new URL(href, `${origin}/`)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  // Host, not origin: a merchant who hand-typed `http://` in a link meant the
  // same page as the `https://` one, and treating them as two would put one
  // page in the graph twice.
  if (url.host.toLowerCase() !== new URL(origin).host) return undefined
  return canonicalStoreUrl(url.pathname, origin)
}
