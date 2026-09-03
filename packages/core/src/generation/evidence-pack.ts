import type { FactSheet } from '../distill/schema'
import type { IntentClass } from '../contracts/opportunities'

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
