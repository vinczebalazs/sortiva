import { marked } from 'marked'
import { CONFIG } from '../config.ts'
import type { EvidencePack, PackImage, PackProduct } from './pack.ts'

/*
 * The writer's Markdown carries three kinds of reference, all removed or resolved before anyone sees it:
 *   [F3] or [F3, F7]  the facts a sentence rests on, just before its closing punctuation
 *   [G]               the sentence states general knowledge, not something about our products
 *   [text](P2)        a link to a product or page from the pack, by reference, never by address
 *   {{P2}}            on a line of its own: a product card
 */

const CITE = /\s*\[((?:F\d+|G)(?:\s*,\s*(?:F\d+|G))*)\]/g
const CARD_LINE = /^\s*\{\{\s*(P\d+)\s*\}\}\s*$/
const LINK = /(!?)\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g

export type Sentence = {
  /** The sentence without its markers. */
  text: string
  facts: string[]
  general: boolean
  /** Headings and the title carry no markers; their numbers are checked differently. */
  heading: boolean
  links: string[]
}

export type Block = { kind: 'heading' | 'paragraph' | 'list_item' | 'table_cell' | 'card'; text: string; level?: number }

/** Splits the writer's Markdown into blocks; tables become one block per cell. */
export function blocks(markdown: string): Block[] {
  const out: Block[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) out.push({ kind: 'paragraph', text: paragraph.join(' ') })
    paragraph = []
  }
  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    const card = line.match(CARD_LINE)
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    const item = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/)
    if (!line) flush()
    else if (card) {
      flush()
      out.push({ kind: 'card', text: card[1]! })
    } else if (heading) {
      flush()
      out.push({ kind: 'heading', text: heading[2]!, level: heading[1]!.length })
    } else if (item) {
      flush()
      out.push({ kind: 'list_item', text: item[1]! })
    } else if (line.startsWith('|')) {
      flush()
      if (/^\|[\s|:-]+\|?$/.test(line)) continue
      for (const cell of line.replace(/^\||\|$/g, '').split('|')) if (cell.trim()) out.push({ kind: 'table_cell', text: cell.trim() })
    } else if (line.startsWith('>')) {
      flush()
      out.push({ kind: 'paragraph', text: line.replace(/^>\s?/, '') })
    } else paragraph.push(line)
  }
  flush()
  return out
}

// A citation written after the full stop ("… 600 ml. [F3]") belongs to the sentence before it.
function attachTrailingCitations(text: string): string {
  return text.replace(/([.!?])(\s*\[(?:F\d+|G)(?:\s*,\s*(?:F\d+|G))*\])/g, '$2$1')
}

/** Every sentence of the article with the facts it cites; the unit the claim checks work on. */
export function sentences(markdown: string): Sentence[] {
  const out: Sentence[] = []
  for (const block of blocks(markdown)) {
    if (block.kind === 'card') continue
    const parts = block.kind === 'heading' ? [block.text] : attachTrailingCitations(block.text).split(/(?<=[.!?])\s+(?=[^\s])/)
    for (const part of parts) {
      const facts: string[] = []
      let general = false
      for (const m of part.matchAll(CITE)) {
        for (const ref of m[1]!.split(',').map((r) => r.trim())) {
          if (ref === 'G') general = true
          else facts.push(ref)
        }
      }
      const links = [...part.matchAll(LINK)].filter((m) => !m[1]).map((m) => m[3]!)
      const text = part.replace(CITE, '').replace(LINK, (_, bang: string, label: string) => (bang ? '' : label)).trim()
      if (text) out.push({ text, facts: [...new Set(facts)], general, heading: block.kind === 'heading', links })
    }
  }
  return out
}

/** Every link target the writer used, including ones written as plain addresses in the text. */
export function linkTargets(markdown: string): string[] {
  const md = [...markdown.matchAll(LINK)].map((m) => m[3]!)
  const bare = [...markdown.replace(LINK, '').matchAll(/\bhttps?:\/\/[^\s)>\]]+|\bwww\.[^\s)>\]]+/gi)].map((m) => m[0])
  return [...md, ...bare]
}

export function cardRefs(markdown: string): string[] {
  return blocks(markdown).filter((b) => b.kind === 'card').map((b) => b.text)
}

/** The image whose shape is closest to the card's slot; the first one when sizes are unknown. */
export function cardImage(images: PackImage[]): PackImage | null {
  if (!images.length) return null
  const target = CONFIG.productCardAspectRatio
  const sized = images.filter((i) => i.width && i.height)
  if (sized.length < 2) return images[0]!
  return sized.reduce((best, i) => (Math.abs(Math.log(i.width! / i.height! / target)) < Math.abs(Math.log(best.width! / best.height! / target)) ? i : best))
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function resolve(pack: EvidencePack, target: string): string {
  return pack.links.find((l) => l.ref === target)?.url ?? target
}

/** The article as the merchant gets it: markers gone, references turned into the store's own addresses. */
function resolved(markdown: string, pack: EvidencePack, card: (p: PackProduct) => string): string {
  return markdown
    .split('\n')
    .map((line) => {
      const m = line.match(CARD_LINE)
      if (!m) return line
      const product = pack.products.find((p) => p.ref === m[1])
      return product ? card(product) : ''
    })
    .join('\n')
    .replace(/[ \t]*\[(?:F\d+|G)(?:\s*,\s*(?:F\d+|G))*\]/g, '')
    .replace(LINK, (whole, bang: string, label: string, target: string) => (bang ? whole : `[${label}](${resolve(pack, target)})`))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function finalMarkdown(markdown: string, pack: EvidencePack): string {
  return resolved(markdown, pack, (p) => {
    const image = cardImage(p.images)
    const href = p.url ?? ''
    return [image ? `[![${p.title}](${image.url})](${href})` : '', `**[${p.title}](${href})**`].filter(Boolean).join('\n\n')
  }) + '\n'
}

/** The bytes sent to the store or exported: one rendering through a real Markdown library, cards as plain HTML. */
export function renderHtml(markdown: string, pack: EvidencePack): string {
  const withSlots = resolved(markdown, pack, (p) => `<!--sortiva-card:${p.ref}-->`)
  const html = marked.parse(withSlots, { async: false, gfm: true, breaks: false }) as string
  return html
    .replace(/<!--sortiva-card:(P\d+)-->\n?/g, (_, ref: string) => cardHtml(pack.products.find((p) => p.ref === ref)!))
    .trim() + '\n'
}

// Inline styles only: the store's theme styles everything else, and its stylesheet is unknown to us.
function cardHtml(p: PackProduct): string {
  const image = cardImage(p.images)
  const href = escapeHtml(p.url ?? '')
  const ratio = CONFIG.productCardAspectRatio
  const img = image
    ? `<a href="${href}"><img src="${escapeHtml(image.url)}" alt="${escapeHtml(p.title)}" loading="lazy" style="display:block;width:100%;aspect-ratio:${ratio.toFixed(4)};object-fit:cover;border-radius:6px"></a>`
    : ''
  return `<div class="sortiva-product" style="max-width:360px;margin:1.5em 0;padding:12px;border:1px solid rgba(0,0,0,.12);border-radius:8px">${img}<p style="margin:10px 0 0"><a href="${href}"><strong>${escapeHtml(p.title)}</strong></a></p></div>\n`
}

/** Plain text of the article, for counting words and detecting its language. */
export function plainText(markdown: string): string {
  return sentences(markdown).map((s) => s.text).join(' ').replace(/[*_`#>|]/g, ' ').replace(/\s+/g, ' ').trim()
}
