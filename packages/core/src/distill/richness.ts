/**
 * How much this store's product pages actually state — one number and one word
 * for the whole catalogue.
 *
 * Some stores' descriptions really are the substance: technical shops,
 * ingredient-driven cosmetics, anything sold on specifications. Others are
 * three adjectives and a photograph. The difference decides how much we can
 * honestly write, so it is measured per store rather than assumed, shown to the
 * merchant at confirmation, and later read by the gate that refuses to write an
 * article padded out of thin data.
 */

/** One product's contribution: how many of the ten extractable fields its description supported. */
export interface RichnessInput {
  readonly populatedFields: number
  readonly factCount: number
}

/**
 * The two numbers this reads, both already in `packages/rules` under
 * `gates.substance_floor`, where the Opportunity Engine's own substance check
 * reads them.
 *
 * Deliberately not a second set of thresholds. The band a merchant is shown at
 * confirmation and the floor that later decides whether we will write about a
 * family are the same judgement about the same data; two independent numbers
 * would eventually disagree, and a store told "rich" whose articles are then
 * refused for thin data has been lied to.
 */
export interface RichnessThresholds {
  /** How many populated fields a product needs to count as usefully described. */
  readonly populatedFieldsPerProductMin: number
  /** Clearing the floor by this multiple is "plenty to say" rather than "just enough". */
  readonly marginMultiple: number
}

export type RichnessBand = 'rich' | 'okay' | 'sparse'

export interface StoreRichness {
  readonly productsScored: number
  /**
   * Products below the floor — the count the confirmation screen shows as
   * "these products are missing key details". A count, never a list: naming
   * them is the products screen's job.
   */
  readonly productsMissingDetails: number
  /** The middle product's populated-field count. The band is read off this. */
  readonly medianPopulatedFields: number
  /** Average facts per product, to two decimals. "How much do we know about this catalogue." */
  readonly score: number
  readonly band: RichnessBand
}

/**
 * The store's richness, from every product we have distilled.
 *
 * The band is read off the **median** product rather than the average, because
 * a catalogue's fact counts are not evenly spread: twenty richly specified
 * products among two hundred bare ones pull an average over the floor while
 * nine in ten pages still say nothing. The median answers the question the band
 * is asked — what is a typical product page here like.
 *
 * A store with nothing distilled yet is `sparse` with a score of zero, which is
 * accurate rather than pessimistic: we know nothing about it.
 */
export function rollUpRichness(
  products: readonly RichnessInput[],
  thresholds: RichnessThresholds,
): StoreRichness {
  if (products.length === 0) {
    return {
      productsScored: 0,
      productsMissingDetails: 0,
      medianPopulatedFields: 0,
      score: 0,
      band: 'sparse',
    }
  }

  const populated = products.map((p) => p.populatedFields).sort((a, b) => a - b)
  const median = medianOf(populated)
  const totalFacts = products.reduce((sum, p) => sum + p.factCount, 0)

  return {
    productsScored: products.length,
    productsMissingDetails: products.filter(
      (p) => p.populatedFields < thresholds.populatedFieldsPerProductMin,
    ).length,
    medianPopulatedFields: median,
    score: Math.round((totalFacts / products.length) * 100) / 100,
    band: bandFor(median, thresholds),
  }
}

function bandFor(median: number, thresholds: RichnessThresholds): RichnessBand {
  if (median < thresholds.populatedFieldsPerProductMin) return 'sparse'
  if (median >= thresholds.populatedFieldsPerProductMin * thresholds.marginMultiple) return 'rich'
  return 'okay'
}

/** An even-sized catalogue takes the lower of the two middle products, so a band is never awarded on half a field. */
function medianOf(sorted: readonly number[]): number {
  const middle = Math.floor((sorted.length - 1) / 2)
  return sorted[middle] ?? 0
}
