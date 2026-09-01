import { PREVIEW_MAX_INPUT_CHARS } from './limits'

/**
 * Pulling usable text out of a homepage, cheaply by design. In priority order:
 * `<title>`, `meta description`, OpenGraph tags, JSON-LD `Organization` /
 * `Product` blocks, then a Readability-style pass over the body as fallback
 * content, concatenated and truncated to a small token budget.
 *
 * "Cheap by design" is the whole specification. There is no DOM here and no
 * `jsdom`: this runs on a public endpoint that bots hit, so it is regular
 * expressions over a capped string, and it never has to be correct — only
 * useful enough for a two-sentence summary and safe to run on hostile input.
 * See DECISIONS 2026-09-01 T1.3.
 */

export interface PreviewSignals {
  readonly title?: string
  readonly description?: string
  readonly siteName?: string
  readonly ogTitle?: string
  readonly ogDescription?: string
  readonly organization?: string
  readonly products: readonly string[]
}

export interface PreviewExtraction {
  readonly signals: PreviewSignals
  /** The concatenated, truncated text handed to the model. */
  readonly text: string
  /**
   * How much usable signal was found, across the structured tags *and* the body
   * text. The decision to try one more page branches on this total, so the
   * readable body counts towards it as much as the structured tags do.
   */
  readonly signalChars: number
}

/** Elements whose text is chrome, not content. */
const STRIPPED_BLOCKS =
  /<(script|style|noscript|template|svg|iframe|nav|header|footer|form|select)\b[^>]*>[\s\S]*?<\/\1>/gi

export function extractPreviewSignals(html: string): PreviewExtraction {
  const capped = html.slice(0, PREVIEW_MAX_INPUT_CHARS * 8)

  const title = firstGroup(capped, /<title[^>]*>([\s\S]*?)<\/title>/i)
  const description = metaContent(capped, 'name', 'description')
  const siteName = metaContent(capped, 'property', 'og:site_name')
  const ogTitle = metaContent(capped, 'property', 'og:title')
  const ogDescription = metaContent(capped, 'property', 'og:description')

  const { organization, products } = jsonLd(capped)

  const signals: PreviewSignals = {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(siteName ? { siteName } : {}),
    ...(ogTitle ? { ogTitle } : {}),
    ...(ogDescription ? { ogDescription } : {}),
    ...(organization ? { organization } : {}),
    products,
  }

  const structured = [
    title,
    siteName,
    ogTitle,
    description,
    ogDescription,
    organization,
    ...products,
  ].filter((value): value is string => value !== undefined && value !== '')

  // Deduplicate: a Shopify theme repeats the store name in four places, and
  // every repeat is input tokens we pay for.
  const seen = new Set<string>()
  const unique = structured.filter((value) => {
    const key = value.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const body = readableText(capped)
  const text = truncate([...unique, body].filter((v) => v !== '').join('\n'), PREVIEW_MAX_INPUT_CHARS)

  return { signals, text, signalChars: text.length }
}

/** A Readability-style extraction over the homepage body, as fallback content. */
export function readableText(html: string): string {
  const body = firstGroup(html, /<body[^>]*>([\s\S]*)<\/body>/i) ?? html
  const stripped = body.replace(STRIPPED_BLOCKS, ' ').replace(/<!--[\s\S]*?-->/g, ' ')

  // Block-level tags become paragraph breaks so the model sees structure rather
  // than one run-on sentence.
  const withBreaks = stripped
    .replace(/<\/(p|div|section|article|li|h[1-6]|br)\s*\/?>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')

  return collapse(decodeEntities(withBreaks.replace(/<[^>]+>/g, ' ')))
}

function metaContent(html: string, attribute: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const withContentAfter = new RegExp(
    `<meta[^>]*\\b${attribute}\\s*=\\s*["']${escaped}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["']`,
    'i',
  )
  const withContentBefore = new RegExp(
    `<meta[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*\\b${attribute}\\s*=\\s*["']${escaped}["']`,
    'i',
  )
  return firstGroup(html, withContentAfter) ?? firstGroup(html, withContentBefore)
}

/** JSON-LD `Organization` and `Product` blocks, which are the most reliable signal when a site has them. */
function jsonLd(html: string): { organization?: string; products: string[] } {
  const products: string[] = []
  let organization: string | undefined

  const blocks = html.matchAll(
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )
  for (const block of blocks) {
    let parsed: unknown
    try {
      parsed = JSON.parse(block[1] ?? '')
    } catch {
      // Malformed JSON-LD is extremely common in the wild; skipping it is the
      // whole handling. It is a bonus signal, never a required one.
      continue
    }
    for (const node of flatten(parsed)) {
      const type = typeOf(node)
      const name = stringField(node, 'name')
      if (type === 'organization' || type === 'store' || type === 'localbusiness') {
        const about = stringField(node, 'description')
        organization ??= [name, about].filter(Boolean).join(' — ') || undefined
      } else if (type === 'product' && name && products.length < 5) {
        products.push(name)
      }
    }
  }
  return organization === undefined ? { products } : { organization, products }
}

/** JSON-LD arrives as an object, an array, or a `@graph`; walk all three shapes. */
function flatten(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 4 || value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((item) => flatten(item, depth + 1))
  const node = value as Record<string, unknown>
  const graph = node['@graph']
  return [node, ...(graph === undefined ? [] : flatten(graph, depth + 1))]
}

function typeOf(node: Record<string, unknown>): string {
  const raw = node['@type']
  const first = Array.isArray(raw) ? raw[0] : raw
  return typeof first === 'string' ? first.toLowerCase() : ''
}

function stringField(node: Record<string, unknown>, key: string): string | undefined {
  const value = node[key]
  return typeof value === 'string' && value.trim() !== '' ? collapse(value) : undefined
}

function firstGroup(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text)
  const value = match?.[1]
  if (value === undefined) return undefined
  const cleaned = collapse(decodeEntities(value))
  return cleaned === '' ? undefined : cleaned
}

function collapse(text: string): string {
  return text.replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'",
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
    const known = ENTITIES[name.toLowerCase()]
    if (known !== undefined) return known
    if (name.startsWith('#')) {
      const code = name.startsWith('#x') || name.startsWith('#X')
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10)
      if (Number.isFinite(code) && code > 0 && code < 0x10ffff) return String.fromCodePoint(code)
    }
    return match
  })
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars).trimEnd()}…`
}
