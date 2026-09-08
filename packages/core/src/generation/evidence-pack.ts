import { EXTRACTED_FIELDS, type FactSheet } from '../distill/schema'
import type { IntentClass } from '../contracts/opportunities'
import type { ProductField } from '../signals/substance'

/**
 * What Gate 2 checks and the claim plan is built from: the merged fact
 * sheets for the topic's mapped families, the SERP context for the target
 * keyword, what the top-ranking competitor pages already cover, and the
 * cheap structural pieces (catalog images, internal-link targets) an article
 * needs.
 *
 * Assembly here is pure — every field arrives already fetched. The fetching
 * itself (family facts from `packages/db`, a SERP snapshot via
 * `SeoDataProvider`, competitor page bodies via the shared `PageFetcher`) is
 * IO and lives in `packages/jobs/src/generation`; main §8.3, "relevant fact
 * sheets, DataForSEO SERP context, competitor angles."
 */

/** One product's fact sheet as the pack carries it — never the raw description (invariant 3). */
export interface EvidencePackProduct {
  readonly productId: string
  readonly title: string
  readonly familyId: string
  readonly factSheet: FactSheet
  /**
   * Catalog image URLs for this product, `cdn.shopify.com` addresses only —
   * never generated or proxied (main §9.2, "product images from the catalog
   * only... No AI image generation"). Empty until the catalog sync persists
   * product images; see this card's session report — `products` has nowhere
   * to store them today.
   */
  readonly images: readonly { readonly url: string }[]
}

export interface EvidencePackFamily {
  readonly familyId: string
  readonly name: string
  readonly differentiationAxes: readonly string[]
}

/** One passage of a top-ranking competitor page, kept short and attributable. */
export interface CompetitorAngle {
  readonly url: string
  readonly domain: string
  readonly position: number
  /** The page's own headings, in order — what it chose to cover. */
  readonly headings: readonly string[]
  /** A short excerpt an external-fact claim may quote from verbatim. */
  readonly excerpt: string
}

export interface SerpContext {
  readonly keyword: string
  readonly locale: string
  readonly topResultCount: number
  /**
   * Average word count across the fetched top results, where a body was
   * readable. Null when every fetch failed — the length target then falls
   * back to `generation.length.fallback_word_count_min` (`packages/rules`).
   */
  readonly averageWordCount: number | null
  readonly competitorAngles: readonly CompetitorAngle[]
}

/** A page the new article must link to and from — main §7.7 step 4. */
export interface EvidencePackLinkTask {
  readonly url: string
  readonly reason: 'existing_target_weak_match'
}

export interface EvidencePack {
  readonly accountId: string
  readonly topicId: string
  readonly intentClass: IntentClass
  readonly targetKeyword: string
  readonly families: readonly EvidencePackFamily[]
  readonly products: readonly EvidencePackProduct[]
  readonly serp: SerpContext
  readonly linkTasks: readonly EvidencePackLinkTask[]
  readonly assembledAt: string
}

export interface AssembleEvidencePackInput {
  readonly accountId: string
  readonly topicId: string
  readonly intentClass: IntentClass
  readonly targetKeyword: string
  readonly families: readonly EvidencePackFamily[]
  readonly products: readonly EvidencePackProduct[]
  readonly serp: SerpContext
  readonly linkTasks: readonly EvidencePackLinkTask[]
  readonly now: Date
}

/**
 * Normalises already-fetched pieces into one pack: dedupes competitor
 * headings and products so a caller that queried the same family twice does
 * not double-count it in Gate 2's distinct-claim count.
 */
export function assembleEvidencePack(input: AssembleEvidencePackInput): EvidencePack {
  const seenProducts = new Set<string>()
  const products = input.products.filter((product) => {
    if (seenProducts.has(product.productId)) return false
    seenProducts.add(product.productId)
    return true
  })

  const seenFamilies = new Set<string>()
  const families = input.families.filter((family) => {
    if (seenFamilies.has(family.familyId)) return false
    seenFamilies.add(family.familyId)
    return true
  })

  return {
    accountId: input.accountId,
    topicId: input.topicId,
    intentClass: input.intentClass,
    targetKeyword: input.targetKeyword,
    families,
    products,
    serp: input.serp,
    linkTasks: input.linkTasks,
    assembledAt: input.now.toISOString(),
  }
}

/** One thing the store itself recorded about a product, at the granularity a claim is made at. */
export interface CitableProductFact {
  readonly productId: string
  readonly productTitle: string
  readonly field: ProductField
  /** A scalar field's value, or one entry of a list field. */
  readonly value: string
  /** One entry of a list field, which reads differently in a sentence than a scalar does. */
  readonly fromList: boolean
}

/**
 * The store's own facts, and the only part of the pack a finished article may
 * rest on.
 *
 * It is narrower than a fact sheet on purpose. Four of the sheet's fields are
 * not things the description said — the price range and the option-axis names
 * are merged from the variant data, and the fluff flag and the fact count are
 * our own bookkeeping — so no claim is ever built from them and no sentence may
 * cite them.
 *
 * It exists so that the writer and the judge cannot end up holding different
 * evidence. The claim plan the writer is given and the store facts the judge
 * grades against are assembled in two different files, and both call this. They
 * used to be assembled separately, and the judge ended up holding whole fact
 * sheets while the writer got the ten description-derived fields — so a price
 * the model had invented could be confirmed against a price range that was
 * never in front of it. `evidence-parity.test.ts` fails if they drift apart
 * again.
 *
 * Order is products in pack order, fields in sheet order, list entries in their
 * own order: the claim ids (`c1`, `c2`, …) an article cites are positions in
 * this list, and they are written into `article_claims`.
 */
export function citableProductFacts(pack: EvidencePack): CitableProductFact[] {
  const facts: CitableProductFact[] = []
  for (const product of pack.products) {
    for (const field of EXTRACTED_FIELDS) {
      const value = product.factSheet[field]
      if (Array.isArray(value)) {
        for (const entry of value) {
          const trimmed = entry.trim()
          if (trimmed === '') continue
          facts.push({
            productId: product.productId,
            productTitle: product.title,
            field,
            value: trimmed,
            fromList: true,
          })
        }
      } else if (typeof value === 'string' && value.trim() !== '') {
        facts.push({
          productId: product.productId,
          productTitle: product.title,
          field,
          value: value.trim(),
          fromList: false,
        })
      }
    }
  }
  return facts
}
