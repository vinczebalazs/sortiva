import type { ProductAttributes } from './attributes'

/**
 * The last resort, for stores where nothing else has anything to work with: no
 * `product_type`, no keyed tags, descriptions too thin to distil.
 *
 * Without it such a store gets two hundred families of one, which is the same
 * as no families at all — every downstream reader would treat each product as
 * its own subject and the whole point of grouping is lost. With it the store
 * gets rough groups, **every one of them flagged low confidence**, so nothing
 * downstream mistakes a guess for a measurement.
 *
 * **This is not a learned embedding.** §6.4 describes embedding the title and
 * fact sheet and clustering the vectors; this build has no embeddings vendor —
 * `packages/llm` wraps one text-completion model and nothing else — and adding
 * one is a provider decision with a bill attached, not something a feature card
 * settles. So the fallback clusters on the words in the titles: a store whose
 * products are called "Ridgeline Trail Shoe" and "Trailblazer Trail Shoe" is
 * telling us they are the same kind of thing in the only way it has left. The
 * families carry `embedding` as their recorded source because that is the
 * schema's name for this lane, and the merged sheet records the method that was
 * actually used. Recorded in DECISIONS; swapping a real embedder in later
 * replaces this function and nothing else.
 */

/**
 * How much of two titles has to be the same word before the products are
 * grouped.
 *
 * Deliberately high. Everything reaching this function has already failed every
 * signal with real evidence behind it, so the choice is between a conservative
 * guess and no answer, and a wrong family here is worse than a missing one: it
 * would put two unrelated products under one heading in an article. UNCALIBRATED.
 */
export const TITLE_OVERLAP_MIN = 0.5

/**
 * When a store is messy enough to need this at all: the share of products that
 * came out of every other signal as a family of one.
 *
 * A store where most products grouped cleanly and a handful did not is not a
 * messy store — those few really are one-offs, and guessing at them would
 * replace a correct singleton with a wrong pair.
 */
export const FALLBACK_SINGLETON_SHARE_MIN = 0.5

/** Words too common in product titles to carry any signal about what a product is. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'in', 'of', 'to', 'by', 'on',
  'new', 'set', 'pack', 'edition', 'classic', 'premium', 'pro', 'plus', 'original',
])

/** Whether the leftovers are numerous enough that guessing beats leaving them alone. */
export function fallbackWarranted(singletons: number, totalProducts: number): boolean {
  if (totalProducts === 0) return false
  return singletons / totalProducts >= FALLBACK_SINGLETON_SHARE_MIN
}

/**
 * Groups leftover products by the words their titles share.
 *
 * Same anchor comparison as the attribute clustering, for the same reason: with
 * pairwise linking one product with a generic title bridges every group in the
 * store into one.
 */
export function clusterByTitleWords(
  products: readonly ProductAttributes[],
): readonly (readonly ProductAttributes[])[] {
  const words = new Map<string, ReadonlySet<string>>()
  for (const product of products) words.set(product.productId, titleWords(product.title))

  const clusters: ProductAttributes[][] = []
  for (const product of products) {
    const own = words.get(product.productId)!
    if (own.size === 0) {
      clusters.push([product])
      continue
    }

    let best: { cluster: ProductAttributes[]; overlap: number } | undefined
    for (const cluster of clusters) {
      const anchor = words.get(cluster[0]!.productId)!
      const overlap = jaccard(own, anchor)
      if (overlap >= TITLE_OVERLAP_MIN && (best === undefined || overlap > best.overlap)) {
        best = { cluster, overlap }
      }
    }

    if (best) best.cluster.push(product)
    else clusters.push([product])
  }

  return clusters
}

/** The words in a title that say something about what the product is. */
export function titleWords(title: string): ReadonlySet<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word) && !/^\d+$/.test(word)),
  )
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / (left.size + right.size - shared)
}
