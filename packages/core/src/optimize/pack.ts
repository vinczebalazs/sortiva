import type { FactSheet } from '../distill/schema'
import type { StorePageType } from '../signals/types'
import type { SubtopicCoverage } from './coverage'

/**
 * Everything a page recommendation is allowed to be made from, assembled
 * without a model: the page as it stands, what it earns in search, what the
 * pages above it settle, what the store actually knows about its products, and
 * which of its other pages could link here.
 *
 * The pack is the whole world the writer sees. That is the same rule article
 * drafting works under, and it is what makes the grounding lint meaningful:
 * every suggestion has to cite an address that appears in here, so a
 * suggestion resting on something the model knew from elsewhere fails a check
 * rather than reaching a merchant.
 */

/** The page being improved, as it stands today. */
export interface OptimizePackPage {
  readonly url: string
  readonly pageType: StorePageType
  /** Null on a page the store never titled — rare, and not a reason to refuse to help with it. */
  readonly title: string | null
  /** What the search result shows, when the merchant set it; the page title otherwise. */
  readonly seoTitle: string | null
  readonly seoDescription: string | null
  readonly headings: readonly string[]
  /** The page's readable text, markup already stripped. */
  readonly bodyText: string
  /** Where this page already links, as addresses on the store's own site. */
  readonly outboundInternalLinks: readonly string[]
  /** `store_pages.checksum` — what says whether the merchant has edited the page since. */
  readonly checksum: string
}

/** One search this page is shown for, over the window the pack was built from. */
export interface OptimizePackQuery {
  readonly query: string
  readonly clicks: number
  readonly impressions: number
  readonly position: number | null
}

/** One page ranking above ours, as far as we could read it. */
export interface OptimizePackRankingPage {
  readonly url: string
  readonly domain: string
  readonly position: number
  readonly title: string | null
  readonly headings: readonly string[]
  readonly excerpt: string
}

/** One product of the store's, and the facts its own words support. */
export interface OptimizePackProduct {
  readonly productId: string
  readonly familyId: string
  readonly title: string
  readonly factSheet: FactSheet
}

export interface OptimizePackFamily {
  readonly familyId: string
  readonly name: string
  /** What tells this family's products apart from each other — main §6.4. */
  readonly differentiationAxes: readonly string[]
}

/** Another page of the store's that could link to this one, or be linked from it. */
export interface OptimizePackLinkCandidate {
  readonly url: string
  readonly title: string | null
  readonly pageType: StorePageType
}

/** How the store describes itself, so suggested copy sounds like them rather than like us. */
export interface OptimizePackPersona {
  readonly description: string
  readonly audience: string
  readonly tone: string
  readonly language: string
  readonly country: string
}

export interface OptimizeEvidencePack {
  readonly accountId: string
  readonly opportunityId: string
  readonly page: OptimizePackPage
  /** The search this recommendation is about — the query cluster's head. */
  readonly targetQuery: string
  /** Search Console for this page over the window, busiest search first. */
  readonly queries: readonly OptimizePackQuery[]
  readonly queryWindowDays: number
  readonly rankingPages: readonly OptimizePackRankingPage[]
  /**
   * What those pages settle and ours does not, from the subtopic comparison
   * (`analyseIntentGap`). Empty when the comparison could not be made — the
   * recommendation is then made from the store's own facts alone, which is
   * weaker but still honest.
   */
  readonly missingSubtopics: readonly SubtopicCoverage[]
  readonly families: readonly OptimizePackFamily[]
  readonly products: readonly OptimizePackProduct[]
  readonly linkCandidates: readonly OptimizePackLinkCandidate[]
  readonly persona: OptimizePackPersona | null
  readonly builtAt: string
}

/**
 * Fact-sheet fields that carry a value worth citing. `variant_axes`,
 * `price_range` and the marketing flag are excluded on purpose: the first two
 * are structured data the merchant's storefront already shows and that a
 * pasted paragraph would go stale against, and the third is a note about the
 * distillation, not a fact about the product.
 */
const CITABLE_FIELDS = [
  'material',
  'dimensions',
  'weight',
  'capacity',
  'compatibility',
  'use_cases_stated',
  'care',
  'certifications',
  'origin',
  'verifiable_claims',
] as const satisfies readonly (keyof FactSheet)[]

export type CitableField = (typeof CITABLE_FIELDS)[number]

/** One citable fact and the address a suggestion has to name it by. */
export interface PackFact {
  /** `product:<id>/<field>`, `family:<id>/axis:<axis>`, or `subtopic:<name>`. */
  readonly address: string
  readonly value: string
  /** What the merchant would recognise it as, used when the recommendation is rendered for reading. */
  readonly label: string
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim()
  if (Array.isArray(value)) {
    const parts = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    return parts.length === 0 ? null : parts.join('; ')
  }
  return null
}

/**
 * Every address a suggestion is allowed to cite, and what is behind each one.
 *
 * Three shapes, and the difference between them is what kind of evidence it
 * is. `product:` and `family:` are things the store itself recorded — the
 * merchant's own facts. `subtopic:` is a reading of the pages ranking above
 * this one, which is a weaker kind of evidence and is labelled differently
 * wherever it is shown. Anything else a model cites is not evidence at all,
 * and the grounding lint drops the suggestion that rests on it.
 */
export function packFacts(pack: OptimizeEvidencePack): PackFact[] {
  const out: PackFact[] = []

  for (const product of pack.products) {
    for (const field of CITABLE_FIELDS) {
      const value = stringValue(product.factSheet[field])
      if (value === null) continue
      out.push({
        address: `product:${product.productId}/${field}`,
        value,
        label: `${product.title} — ${field.replace(/_/g, ' ')}`,
      })
    }
  }

  for (const family of pack.families) {
    for (const axis of family.differentiationAxes) {
      const value = stringValue(axis)
      if (value === null) continue
      out.push({
        address: `family:${family.familyId}/axis:${value}`,
        value,
        label: `${family.name} — how these differ: ${value}`,
      })
    }
  }

  for (const subtopic of pack.missingSubtopics) {
    const pages = subtopic.competitors.map((c) => c.url).join('; ')
    out.push({
      address: `subtopic:${subtopic.name}`,
      value: subtopic.name,
      label: `Covered by the pages above you: ${subtopic.name} (${pages})`,
    })
  }

  return out
}

/** The addresses alone, which is what the grounding lint checks against. */
export function packFactAddresses(pack: OptimizeEvidencePack): Set<string> {
  return new Set(packFacts(pack).map((fact) => fact.address))
}

/**
 * Every address on the store the recommendation may propose a link to or from.
 *
 * The page's own address is in here: a suggestion to link *to* this page from
 * elsewhere names this page as the target, and a lint that did not know it
 * would reject the most ordinary suggestion the pipeline makes.
 */
export function packLinkAddresses(pack: OptimizeEvidencePack): Set<string> {
  const out = new Set<string>([pack.page.url])
  for (const candidate of pack.linkCandidates) out.add(candidate.url)
  return out
}
