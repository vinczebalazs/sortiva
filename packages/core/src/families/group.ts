import { productAttributes, type ProductAttributes, type ProductAttributeInput } from './attributes'
import {
  clusterByAttributes,
  differentiationAxes,
  mergeFactSheets,
  participatesInSimilarity,
  type ClusterOptions,
  type FamilyConfidence,
  type FamilyPlan,
  type FamilyGroupingSource,
} from './cluster'
import { clusterByTitleWords, fallbackWarranted } from './fallback'
import { detectLogicalProducts, variantTokensOf } from './splitVariants'
import { taxonomyKeyFor, taxonomyLabel } from './taxonomy'

/**
 * Grouping a store's catalogue into families, cheapest signal first.
 *
 * The order is the point. Each signal costs more and is trusted less than the
 * one before it, so a product is only ever handed on to a weaker signal because
 * every stronger one had nothing to say about it:
 *
 *  1. **The merchant's own taxonomy** — free, and a statement they made rather
 *     than an inference we drew, so the most trustworthy thing here.
 *  2. **Split-variant merging** — free and deterministic: rows that are one
 *     product published several times, merged into one logical product first so
 *     four colours of one shoe do not read as four shoes.
 *  3. **Fact-sheet clustering** — deterministic and auditable, over structured
 *     facts rather than prose, and the source of the axes that make a family
 *     worth having.
 *  4. **The last-resort fallback** — a guess, flagged low confidence, used only
 *     for stores where everything above found nothing.
 *
 * Nothing here reads a product description. Grouping sees fact sheets, tags,
 * titles and taxonomy names, and the description it was distilled from is
 * quarantined two layers away.
 */

export interface GroupingInput {
  readonly productId: string
  readonly title: string
  readonly factSheet: ProductAttributeInput['factSheet']
  readonly populatedFields: number
  readonly tags?: readonly string[]
  readonly productType?: string | null
}

export interface GroupingPlan {
  readonly families: readonly FamilyPlan[]
  /**
   * Product id → the group of rows that are the same product. Rows sharing a
   * key were published separately and merged; a product on its own gets its own
   * key.
   */
  readonly logicalProducts: ReadonlyMap<string, string>
}

/**
 * How much of a family's evidence has to be the merchant's own before we say we
 * are sure of it.
 *
 * A family the merchant filed themselves is `high`; one we worked out from
 * matching fact sheets is `medium`, because the facts are theirs but the
 * grouping is ours; the fallback is always `low`. A family of one is `high` —
 * "this product is on its own" is a claim nothing could be wrong about.
 */
const CONFIDENCE_BY_SOURCE: Readonly<Record<FamilyGroupingSource, FamilyConfidence>> = {
  collection: 'high',
  split_variant: 'high',
  fact_cluster: 'medium',
  embedding: 'low',
}

export function groupProducts(
  products: readonly GroupingInput[],
  options: ClusterOptions,
): GroupingPlan {
  // Sorted once, and everything below keeps that order, so the same catalogue
  // always produces the same families whatever order the rows arrived in.
  const ordered = [...products].sort((a, b) => a.productId.localeCompare(b.productId))

  const attributes = ordered.map((product) =>
    productAttributes({
      productId: product.productId,
      title: product.title,
      factSheet: product.factSheet,
      populatedFields: product.populatedFields,
      ...(product.tags ? { tags: product.tags } : {}),
      taxonomyKey: taxonomyKeyFor({
        ...(product.productType === undefined ? {} : { productType: product.productType }),
      }),
      variantTokens: variantTokensOf(product.title),
    }),
  )

  const byId = new Map(attributes.map((product) => [product.productId, product]))

  // Step 2 before step 1 in the code, because taxonomy families are counted in
  // logical products rather than rows: a merchant with one shoe in four colours
  // and a taxonomy naming it has one product, not four.
  const logical = detectLogicalProducts(attributes)
  const logicalProducts = new Map<string, string>()
  for (const group of logical) {
    const key = group.memberIds[0]!
    for (const memberId of group.memberIds) logicalProducts.set(memberId, key)
  }

  const families: FamilyPlan[] = []
  const placed = new Set<string>()

  // ── 1. The merchant's own taxonomy ────────────────────────────────────────
  const byTaxonomy = new Map<string, ProductAttributes[]>()
  for (const product of attributes) {
    if (!product.taxonomyKey) continue
    const bucket = byTaxonomy.get(product.taxonomyKey) ?? []
    bucket.push(product)
    byTaxonomy.set(product.taxonomyKey, bucket)
  }
  for (const [key, members] of [...byTaxonomy.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // A taxonomy name used once is not a grouping, it is a label on one
    // product. Left to the signals below, which may still find it a home.
    if (distinctLogicalProducts(members, logicalProducts) < 2) continue
    families.push(planFor(members, 'collection', options, { taxonomyKey: key, name: taxonomyLabel(key) }))
    for (const member of members) placed.add(member.productId)
  }

  // ── 2. Split-variant merges the taxonomy did not already cover ────────────
  for (const group of logical) {
    if (group.memberIds.length < 2) continue
    if (group.memberIds.some((id) => placed.has(id))) continue
    const members = group.memberIds.map((id) => byId.get(id)!)
    families.push(
      planFor(members, 'split_variant', options, {
        name: group.residualTitle === '' ? members[0]!.title : titleCase(group.residualTitle),
      }),
    )
    for (const member of members) placed.add(member.productId)
  }

  // ── 3. Fact-sheet clustering ──────────────────────────────────────────────
  const remaining = attributes.filter((product) => !placed.has(product.productId))
  const leftovers: ProductAttributes[] = []
  for (const cluster of clusterByAttributes(remaining, options)) {
    if (cluster.length < 2 || !participatesInSimilarity(cluster[0]!, options)) {
      leftovers.push(...cluster)
      continue
    }
    families.push(
      planFor(cluster, 'fact_cluster', options, {
        anchorProductId: cluster[0]!.productId,
        name: familyNameFor(cluster),
      }),
    )
    for (const member of cluster) placed.add(member.productId)
  }

  // ── 4. The fallback, only for a store the rest of this found nothing in ───
  if (fallbackWarranted(leftovers.length, attributes.length)) {
    for (const cluster of clusterByTitleWords(leftovers)) {
      if (cluster.length < 2) {
        families.push(singleton(cluster[0]!, options))
        continue
      }
      families.push(
        planFor(cluster, 'embedding', options, {
          anchorProductId: cluster[0]!.productId,
          name: familyNameFor(cluster),
          method: 'title_tokens',
        }),
      )
    }
  } else {
    for (const product of leftovers) families.push(singleton(product, options))
  }

  return { families: withUniqueNames(families), logicalProducts }
}

/**
 * Where one product belongs among families that already exist — the path a
 * single edited product takes.
 *
 * §6.4 asks for family assignment to re-run "for affected products only", and
 * this is what makes that possible: a merchant editing one description must not
 * cost a whole-catalogue regrouping, and must not silently move forty other
 * products because one attribute changed.
 *
 * Returns nothing when no family fits well enough, which the caller reads as
 * "this needs a full regroup" rather than as "put it anywhere".
 */
export function assignToExistingFamily(
  product: GroupingInput,
  families: readonly { readonly name: string; readonly members: readonly ProductAttributes[] }[],
  options: ClusterOptions,
): string | undefined {
  const attributes = productAttributes({
    productId: product.productId,
    title: product.title,
    factSheet: product.factSheet,
    populatedFields: product.populatedFields,
    ...(product.tags ? { tags: product.tags } : {}),
    taxonomyKey: taxonomyKeyFor({
      ...(product.productType === undefined ? {} : { productType: product.productType }),
    }),
    variantTokens: variantTokensOf(product.title),
  })

  // The merchant's own filing wins, exactly as it does in a full regroup.
  if (attributes.taxonomyKey) {
    const named = families.find((family) => family.name === taxonomyLabel(attributes.taxonomyKey!))
    if (named) return named.name
  }
  if (!participatesInSimilarity(attributes, options)) return undefined

  const clustered = clusterByAttributes(
    [
      ...families.flatMap((family) => (family.members[0] ? [family.members[0]] : [])),
      attributes,
    ],
    options,
  )
  const home = clustered.find(
    (cluster) => cluster.length > 1 && cluster.some((member) => member.productId === attributes.productId),
  )
  if (!home) return undefined
  const anchor = home.find((member) => member.productId !== attributes.productId)
  return families.find((family) => family.members[0]?.productId === anchor?.productId)?.name
}

function planFor(
  members: readonly ProductAttributes[],
  source: FamilyGroupingSource,
  options: ClusterOptions,
  provenance: { taxonomyKey?: string; anchorProductId?: string; name: string; method?: string },
): FamilyPlan {
  const merged = mergeFactSheets(members, options)
  const { axes } = differentiationAxes(members)
  return {
    name: provenance.name,
    memberProductIds: members.map((member) => member.productId),
    axes,
    mergedFacts: {
      ...merged,
      ...(provenance.taxonomyKey === undefined ? {} : { taxonomyKey: provenance.taxonomyKey }),
      ...(provenance.anchorProductId === undefined
        ? {}
        : { anchorProductId: provenance.anchorProductId }),
      ...(provenance.method === undefined ? {} : { method: provenance.method }),
    },
    groupingSource: source,
    confidence: CONFIDENCE_BY_SOURCE[source],
  }
}

/**
 * A product nothing grouped: its own family of one.
 *
 * Recorded as a family rather than left without one, because "this product
 * stands alone" is a fact the rest of the product needs — a topic mapped to it
 * covers one product, and the substance floor should say so.
 */
function singleton(product: ProductAttributes, options: ClusterOptions): FamilyPlan {
  return planFor([product], 'fact_cluster', options, {
    anchorProductId: product.productId,
    name: product.title,
    method: 'singleton',
  })
}

/** How many separate products a set of rows amounts to, once split variants count once. */
function distinctLogicalProducts(
  members: readonly ProductAttributes[],
  logicalProducts: ReadonlyMap<string, string>,
): number {
  return new Set(members.map((member) => logicalProducts.get(member.productId) ?? member.productId))
    .size
}

/** The words a cluster's titles share, which is the closest thing to a name nobody wrote. */
function familyNameFor(members: readonly ProductAttributes[]): string {
  const counts = new Map<string, number>()
  for (const member of members) {
    for (const word of new Set(member.title.toLowerCase().split(/[^a-z0-9]+/i))) {
      if (word.length > 2) counts.set(word, (counts.get(word) ?? 0) + 1)
    }
  }
  const shared = [...counts.entries()]
    .filter(([, held]) => held === members.length)
    .map(([word]) => word)
  if (shared.length === 0) return members[0]!.title
  // Kept in the order the anchor's title uses them, so the name reads as a
  // phrase the merchant would recognise rather than as an alphabetised list.
  const order = members[0]!.title.toLowerCase().split(/[^a-z0-9]+/i)
  return titleCase(order.filter((word) => shared.includes(word)).join(' '))
}

/**
 * Family names have to be distinct within a store, because the name is also how
 * a recompute recognises a family it has seen before. Two clusters that arrive
 * at the same name are told apart by a suffix rather than one of them silently
 * absorbing the other's members on the next run.
 */
function withUniqueNames(families: readonly FamilyPlan[]): readonly FamilyPlan[] {
  const seen = new Map<string, number>()
  return families.map((family) => {
    const used = seen.get(family.name) ?? 0
    seen.set(family.name, used + 1)
    return used === 0 ? family : { ...family, name: `${family.name} (${used + 1})` }
  })
}

function titleCase(value: string): string {
  return value.trim().replace(/\b[a-z]/g, (character) => character.toUpperCase())
}
