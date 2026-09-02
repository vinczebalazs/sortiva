import type { FactSheet } from '../distill/schema'
import type { LocaleDetection } from './locale'
import {
  PERSONA_MAX_FAMILIES,
  PERSONA_MAX_PAGE_CHARS,
  PERSONA_MAX_TOP_SELLERS,
} from './limits'

/**
 * Everything the persona call is told about a store, and the point at which the
 * quarantine on product descriptions is either kept or broken.
 *
 * It is kept structurally rather than carefully. The types below have nowhere
 * to put a description: a family carries the facts its members *agree* on and
 * the axes they differ along, a top seller carries a title and a rank, and the
 * store's own pages carry the store's own prose about itself. There is no field
 * a merchant's product marketing could travel in, so the rule holds by the
 * shape of the data rather than by anyone remembering it.
 *
 * The reason for describing a catalogue as families rather than as products is
 * the same reason families exist at all. "Four hundred products" tells a model
 * to describe a large shop; "six families, one of which differs by terrain,
 * drop and width" tells it what the shop actually sells. A store's breadth is a
 * property of its families, and its depth is a property of their axes.
 */

/** One family as the persona call sees it: what its members share, and how they differ. */
export interface FamilyBrief {
  readonly name: string
  readonly memberCount: number
  /** The attributes members differ along — the store's real product dimensions. */
  readonly differentiationAxes: readonly string[]
  /** What every member agrees on. Distilled facts only; no description ever reaches this. */
  readonly mergedFacts: FactSheet
}

/** One best-selling product, by title and position. What the store actually moves. */
export interface TopSellerBrief {
  readonly title: string
  readonly rank: number
}

/** The store's own prose about itself, as fetched from its own site. */
export interface StorePageBrief {
  readonly kind: 'homepage' | 'about'
  readonly text: string
}

export interface PersonaBriefInput {
  /** The claimed domain. The model is told it so a brand name in the address is available to it. */
  readonly domain: string
  readonly families: readonly FamilyBrief[]
  /** How many products the catalogue holds in total, families or not. */
  readonly productCount: number
  readonly topSellers: readonly TopSellerBrief[]
  readonly pages: readonly StorePageBrief[]
  /** What the detection chain concluded, passed on so the model is not asked to re-derive it. */
  readonly locale: LocaleDetection
}

/**
 * The brief as the model receives it.
 *
 * Plain prose with headed sections rather than JSON: the answer is a judgement
 * about a business, and a wall of nested objects reads to a model as data to be
 * transformed rather than a shop to be described.
 */
export function renderPersonaBrief(input: PersonaBriefInput): string {
  const sections: string[] = []

  sections.push(`Store address: ${input.domain}`)

  const known: string[] = []
  if (input.locale.language) {
    known.push(`language: ${input.locale.language} (from ${input.locale.languageSource})`)
  }
  if (input.locale.country) {
    known.push(`country: ${input.locale.country} (from ${input.locale.countrySource})`)
  }
  sections.push(
    known.length > 0
      ? `Already established from the store's own settings and markup — ${known.join('; ')}.`
      : `Neither the language nor the country could be established from the store's settings or markup.`,
  )

  const families = [...input.families]
    .sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name))
    .slice(0, PERSONA_MAX_FAMILIES)

  sections.push(
    `Catalogue: ${input.productCount} product(s), grouped into ${input.families.length} ` +
      `product family/families.${families.length < input.families.length ? ` The ${families.length} largest are listed.` : ''}`,
  )

  if (families.length > 0) {
    sections.push(['Product families:', ...families.map(renderFamily)].join('\n'))
  }

  const sellers = [...input.topSellers]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, PERSONA_MAX_TOP_SELLERS)
  if (sellers.length > 0) {
    sections.push(
      ['Best sellers, in order:', ...sellers.map((s) => `${s.rank}. ${s.title}`)].join('\n'),
    )
  }

  for (const page of input.pages) {
    const text = page.text.trim()
    if (text === '') continue
    const label = page.kind === 'homepage' ? 'Homepage text' : 'About page text'
    sections.push(`${label}:\n${truncateAtWord(text, PERSONA_MAX_PAGE_CHARS)}`)
  }

  return sections.join('\n\n')
}

function renderFamily(family: FamilyBrief): string {
  const parts = [`- ${family.name} (${family.memberCount} product(s))`]
  if (family.differentiationAxes.length > 0) {
    parts.push(`  members differ by: ${family.differentiationAxes.join(', ')}`)
  }
  const shared = sharedFacts(family.mergedFacts)
  if (shared.length > 0) parts.push(`  shared across members: ${shared.join('; ')}`)
  return parts.join('\n')
}

/**
 * The merged sheet as a sentence, skipping everything the family did not agree
 * on. An empty list is the honest answer for a family whose members share no
 * stated attribute, and saying so is more useful than a row of nulls.
 */
function sharedFacts(facts: FactSheet): string[] {
  const out: string[] = []
  const scalar: [string, string | null][] = [
    ['material', facts.material],
    ['dimensions', facts.dimensions],
    ['weight', facts.weight],
    ['capacity', facts.capacity],
    ['care', facts.care],
    ['origin', facts.origin],
  ]
  for (const [label, value] of scalar) {
    if (value && value.trim() !== '') out.push(`${label}: ${value.trim()}`)
  }

  const lists: [string, readonly string[]][] = [
    ['compatibility', facts.compatibility],
    ['stated uses', facts.use_cases_stated],
    ['certifications', facts.certifications],
    ['claims', facts.verifiable_claims],
  ]
  for (const [label, values] of lists) {
    const cleaned = values.map((v) => v.trim()).filter((v) => v !== '')
    if (cleaned.length > 0) out.push(`${label}: ${cleaned.join(', ')}`)
  }

  if (facts.price_range) {
    out.push(`price range: ${facts.price_range.min}–${facts.price_range.max}`)
  }
  return out
}

function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const cut = text.slice(0, maxChars)
  const lastBreak = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'))
  return (lastBreak > maxChars * 0.8 ? cut.slice(0, lastBreak) : cut).trimEnd()
}
