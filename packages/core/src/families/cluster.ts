import { attributeSimilarity, type ProductAttributes } from './attributes'

/**
 * Turning a set of products into families, and recording what makes the members
 * of each one different from one another.
 *
 * The axes are the prize. A family differing only by colour supports at most
 * one article; a family differing by terrain, drop and width supports a buying
 * guide whose section headings are literally that list. So a family is not just
 * a bag of products — it is a bag of products plus the reason they are
 * comparable, and the reason is what the rest of the product writes from.
 */

/** Which signal produced a family, kept so a wrong grouping can be traced to what caused it. */
export type FamilyGroupingSource = 'collection' | 'split_variant' | 'fact_cluster' | 'embedding'

export type FamilyConfidence = 'low' | 'medium' | 'high'

/**
 * A family's merged fact sheet: what its members agree on, what they differ
 * along, and how much the two together amount to.
 *
 * The counts are here rather than computed by every reader because they are the
 * numbers the substance floor asks for — enough distinct facts, across enough
 * contributing products, before anything is written about this family.
 */
export interface MergedFactSheet {
  /** Attribute → the values every contributing member states. What is true of the whole family. */
  readonly shared: Readonly<Record<string, readonly string[]>>
  /** Axis → every value any member states. A buying guide's sections come straight off this. */
  readonly axisValues: Readonly<Record<string, readonly string[]>>
  /** Distinct `name=value` pairs across the family. */
  readonly distinctFacts: number
  /** Members that cleared the per-product floor and so actually contributed. */
  readonly contributingProducts: number
  /** Where each axis name came from: the merchant's tags, our fact sheet, or a variant word in a title. */
  readonly axisSources: Readonly<Record<string, string>>
  /** The merchant's own taxonomy name, when that is what produced this family. */
  readonly taxonomyKey?: string
  /** The product every other member was compared against, when similarity produced this family. */
  readonly anchorProductId?: string
  /**
   * What was actually compared, in plain terms. `grouping_source` names the
   * signal; this names the method, and the two differ for the fallback — whose
   * recorded source is `embedding` because that is the schema's word for the
   * last-resort lane, while what it really compared was the words in the titles.
   */
  readonly method?: string
}

export interface FamilyPlan {
  /**
   * The family's name, and also its identity across runs: a recompute matches
   * an existing family by this and updates it, so ids other tables point at
   * survive. There is no key column to hold something better.
   */
  readonly name: string
  readonly memberProductIds: readonly string[]
  /** The axes members differ along, most-shared first. */
  readonly axes: readonly string[]
  readonly mergedFacts: MergedFactSheet
  readonly groupingSource: FamilyGroupingSource
  readonly confidence: FamilyConfidence
}

/**
 * How much two products have to agree before they are one family.
 *
 * `nameOverlap` asks whether they describe themselves in the same terms at all;
 * `valueAgreement` asks whether they mostly hold the same values, the
 * exceptions being the axes. Both have to hold: high agreement over two shared
 * attributes is a coincidence, and high overlap with no agreement is two
 * different products described by the same shop.
 *
 * Not in `packages/rules`. That file holds the numbers deciding whether an
 * opportunity is detected, scored or published, each with a calibration story;
 * these decide how coarse the grouping is. Raising them makes more, smaller
 * families — more articles, each covering less; lowering them makes fewer,
 * broader ones, and eventually one family of everything, which is the failure
 * that matters. UNCALIBRATED, and recorded in DECISIONS as a candidate for the
 * config file once a real store has been grouped.
 */
export const CLUSTER_NAME_OVERLAP_MIN = 0.6
export const CLUSTER_VALUE_AGREEMENT_MIN = 0.5

/**
 * How many members a family needs before its differentiation axes are believed.
 *
 * One product cannot differ from itself, and two products differing on one
 * attribute is as likely to be two unrelated items as a family. Below this the
 * family still exists and still holds its members; it simply reports no axes,
 * which reads downstream as "not enough here for a comparison" — the honest
 * answer.
 */
export const AXIS_MEMBERS_MIN = 3

export interface ClusterOptions {
  /**
   * How many of the fact sheet's ten fields a product must have populated to
   * take part in similarity merging. Comes from the substance floor in
   * `packages/rules`, so the bar a product must clear to be *grouped* by
   * similarity is the same one it must clear to be *written about*.
   */
  readonly populatedFieldsPerProductMin: number
}

/**
 * Whether a product may be merged with others on the strength of how similar it
 * looks.
 *
 * Near-empty fact sheets make everything look identical: two products stating
 * nothing agree on nothing and disagree on nothing, and a similarity measure
 * reads that as a perfect match. That would collapse a thin store into one
 * family and produce a single article claiming to cover the catalogue. Sparse
 * must read as *unknown*, never as *same*, so these products sit out the
 * similarity signals and stay singletons unless the merchant's own taxonomy or
 * a split-variant title puts them somewhere — both of which are statements the
 * merchant made, not inferences we drew.
 */
export function participatesInSimilarity(
  product: ProductAttributes,
  options: ClusterOptions,
): boolean {
  return product.populatedFields >= options.populatedFieldsPerProductMin
}

/**
 * Groups products by how alike they are, comparing each against a family's
 * anchor rather than against every member.
 *
 * Anchor comparison is what stops a family chaining across the catalogue: with
 * pairwise linking, A close to B and B close to C puts A and C together however
 * far apart they are, and one loose product bridges two families that have
 * nothing to do with each other. Iteration order is the given order, which
 * callers sort, so the same catalogue always produces the same families.
 */
export function clusterByAttributes(
  products: readonly ProductAttributes[],
  options: ClusterOptions,
): readonly (readonly ProductAttributes[])[] {
  const clusters: ProductAttributes[][] = []

  for (const product of products) {
    if (!participatesInSimilarity(product, options)) {
      clusters.push([product])
      continue
    }

    let best: { cluster: ProductAttributes[]; overlap: number } | undefined
    for (const cluster of clusters) {
      const anchor = cluster[0]!
      if (!participatesInSimilarity(anchor, options)) continue
      const similarity = attributeSimilarity(anchor, product)
      if (
        similarity.nameOverlap >= CLUSTER_NAME_OVERLAP_MIN &&
        similarity.valueAgreement >= CLUSTER_VALUE_AGREEMENT_MIN &&
        (best === undefined || similarity.nameOverlap > best.overlap)
      ) {
        best = { cluster, overlap: similarity.nameOverlap }
      }
    }

    if (best) best.cluster.push(product)
    else clusters.push([product])
  }

  return clusters
}

/**
 * The axes a set of products differ along, and the values behind each.
 *
 * An axis is an attribute that enough members name and that they do not all
 * answer the same way. Ordered by how many members state it, then by how many
 * answers there are, then by name — so the ordering is a property of the
 * catalogue rather than of the order rows came out of the database, and the
 * same store always shows the same headings.
 */
export function differentiationAxes(
  members: readonly ProductAttributes[],
): { axes: readonly string[]; values: Record<string, readonly string[]>; sources: Record<string, string> } {
  if (members.length < AXIS_MEMBERS_MIN) return { axes: [], values: {}, sources: {} }

  const coverage = new Map<string, number>()
  const values = new Map<string, Set<string>>()
  const sources = new Map<string, string>()

  for (const member of members) {
    for (const [name, held] of member.attributes) {
      coverage.set(name, (coverage.get(name) ?? 0) + 1)
      const bucket = values.get(name) ?? new Set<string>()
      for (const value of held) bucket.add(value)
      values.set(name, bucket)
      if (!sources.has(name)) sources.set(name, member.sources.get(name) ?? 'fact_sheet')
    }
  }

  const axes = [...values.entries()]
    .filter(([name, bucket]) => bucket.size > 1 && (coverage.get(name) ?? 0) >= 2)
    .sort(([leftName, leftValues], [rightName, rightValues]) => {
      const byCoverage = (coverage.get(rightName) ?? 0) - (coverage.get(leftName) ?? 0)
      if (byCoverage !== 0) return byCoverage
      const bySpread = rightValues.size - leftValues.size
      if (bySpread !== 0) return bySpread
      return leftName.localeCompare(rightName)
    })
    .map(([name]) => name)

  return {
    axes,
    values: Object.fromEntries(axes.map((name) => [name, [...values.get(name)!].sort()])),
    sources: Object.fromEntries(axes.map((name) => [name, sources.get(name) ?? 'fact_sheet'])),
  }
}

/**
 * The family's merged fact sheet: what every contributing member agrees on,
 * what they differ along, and the two counts the substance floor reads.
 *
 * "Contributing" means clearing the per-product floor. A family of three well
 * described products and nine bare ones is described by the three: including
 * the nine would let a store add empty products to make a family look richer,
 * which is the gaming §6.3 says the score must not permit.
 */
export function mergeFactSheets(
  members: readonly ProductAttributes[],
  options: ClusterOptions,
): MergedFactSheet {
  const contributing = members.filter((member) => participatesInSimilarity(member, options))
  const scored = contributing.length > 0 ? contributing : members
  const { axes, values, sources } = differentiationAxes(members)
  const axisNames = new Set(axes)

  const shared: Record<string, readonly string[]> = {}
  const facts = new Set<string>()
  const counts = new Map<string, Map<string, number>>()

  for (const member of scored) {
    for (const [name, held] of member.attributes) {
      const bucket = counts.get(name) ?? new Map<string, number>()
      for (const value of held) {
        bucket.set(value, (bucket.get(value) ?? 0) + 1)
        facts.add(`${name}=${value}`)
      }
      counts.set(name, bucket)
    }
  }

  for (const [name, bucket] of counts) {
    if (axisNames.has(name)) continue
    const agreed = [...bucket.entries()]
      .filter(([, held]) => held === scored.length)
      .map(([value]) => value)
      .sort()
    if (agreed.length > 0) shared[name] = agreed
  }

  return {
    shared,
    axisValues: values,
    distinctFacts: facts.size,
    contributingProducts: contributing.length,
    axisSources: sources,
  }
}
