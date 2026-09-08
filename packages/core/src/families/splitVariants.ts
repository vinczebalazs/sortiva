import {
  attributeSimilarity,
  type AttributeValue,
  type ProductAttributes,
} from './attributes'

/**
 * "Trailblazer Shoe — Red" and "Trailblazer Shoe — Blue" published as two
 * products instead of one product with two variants.
 *
 * Writing about them separately is writing the same article twice, and counting
 * them separately makes a store of ten products look like a store of forty. So
 * where the titles differ only by a colour, a size or a material, and the fact
 * sheets behind them agree, the rows are merged into one **logical product** —
 * tighter than a family, because it is the same product.
 *
 * The merge is deterministic and costs nothing: no model call, no vendor call,
 * no embedding. It is also the only place a variant word becomes an axis name —
 * a family whose members are one product in four colours differs along `color`,
 * and that is why it supports one article rather than a buying guide.
 */

/**
 * Words that mark a title fragment as naming a variant rather than a product.
 *
 * English only, and that is a real limit rather than an oversight: a German or
 * French store's colour words are not here, so its split variants stay
 * unmerged and are grouped by the signals that follow. Unmerged is the safe
 * failure — two rows for one product, rather than two products collapsed into
 * one because a word looked like a colour.
 */
const VARIANT_TOKENS: Readonly<Record<string, readonly string[]>> = {
  color: [
    'black', 'white', 'grey', 'gray', 'silver', 'charcoal', 'navy', 'blue', 'teal', 'turquoise',
    'green', 'olive', 'lime', 'yellow', 'gold', 'orange', 'coral', 'red', 'burgundy', 'maroon',
    'pink', 'rose', 'purple', 'violet', 'lilac', 'brown', 'tan', 'beige', 'cream', 'ivory',
    'natural', 'multicolour', 'multicolor',
  ],
  size: [
    'xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl', 'small', 'medium', 'large', 'petite',
    'regular', 'tall', 'short', 'mini', 'midi', 'maxi', 'oversized',
  ],
  material: [
    'leather', 'suede', 'nubuck', 'canvas', 'denim', 'cotton', 'linen', 'wool', 'merino',
    'cashmere', 'silk', 'nylon', 'polyester', 'mesh', 'rubber', 'bamboo', 'ceramic', 'steel',
    'stainless', 'aluminium', 'aluminum', 'brass', 'copper', 'oak', 'walnut', 'pine', 'glass',
  ],
}

/** What a title said once the variant words were taken out of it. */
export interface StrippedTitle {
  /** The title with variant words removed and whitespace settled. Lower-cased for comparison. */
  readonly residual: string
  /** The variant words that were removed, as named attributes. */
  readonly tokens: readonly AttributeValue[]
}

/**
 * Takes the variant words out of a product title.
 *
 * Splits on the separators merchants actually use — a dash, an en dash, a
 * slash, a comma, a pipe, brackets — and drops a fragment made entirely of
 * variant words. A fragment that is partly a variant word keeps its whole self:
 * "Red Rock Sandal" is a product called Red Rock, not a red Rock Sandal, and
 * stripping the "Red" would merge it with a product it has nothing to do with.
 */
export function stripVariantTokens(title: string): StrippedTitle {
  const fragments = title.split(/\s*[-–—/|,()[\]]+\s*/)
  const kept: string[] = []
  const tokens: AttributeValue[] = []

  for (const fragment of fragments) {
    const words = fragment
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word !== '')
    if (words.length === 0) continue

    const classified = words.map((word) => ({ word, name: variantClassOf(word) }))
    if (classified.every((entry) => entry.name !== undefined)) {
      for (const entry of classified) {
        tokens.push({ name: entry.name!, value: entry.word, source: 'variant_token' })
      }
      continue
    }
    kept.push(words.join(' '))
  }

  return {
    residual: kept.join(' ').replace(/\s+/g, ' ').trim(),
    tokens,
  }
}

/** Which variant axis a word names, or none. */
export function variantClassOf(word: string): string | undefined {
  const cleaned = word.replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (cleaned === '') return undefined
  for (const [name, words] of Object.entries(VARIANT_TOKENS)) {
    if (words.includes(cleaned)) return name
  }
  return undefined
}

/** One logical product: the rows that are the same product published separately. */
export interface LogicalProduct {
  /** The residual title the members share. Empty only when a title was nothing but variant words. */
  readonly residualTitle: string
  /** Member product ids, in the order given. The first is the group's anchor. */
  readonly memberIds: readonly string[]
  /** The axes the members differ along — `color`, `size`. */
  readonly axes: readonly string[]
}

/**
 * How closely the fact sheets behind two split-variant candidates have to agree
 * before the rows are merged.
 *
 * Both halves of §6.4's rule have to hold — "residual titles collide *and* fact
 * sheets match" — because the title alone is not enough: a store selling
 * "Trailblazer Shoe" and "Trailblazer Bag" in the same colours would collide on
 * neither, but one selling "Trailblazer 2 — Red" and "Trailblazer 2 — Kids"
 * would collide on a title and mean two different products.
 *
 * Not in `packages/rules`: that file holds the numbers that decide whether an
 * opportunity is detected, scored or published, and this decides whether two
 * database rows are one product. Raising it merges less and leaves duplicate
 * rows; lowering it merges two genuinely different products into one, which is
 * the worse failure — so it starts high. UNCALIBRATED, and named here so it is
 * one line to move.
 */
const SPLIT_VARIANT_AGREEMENT_MIN = 0.8

/**
 * The bucket key a row gets when its title was nothing but variant words.
 *
 * Such a title names no product, so the row must not share a bucket with
 * anything — not even with another row whose title also stripped to nothing.
 * Prefixing the row's own product id leaves each of them alone.
 *
 * A single space puts that key out of reach of every real title in every
 * language, and the guarantee is structural rather than a guess about what a
 * merchant might type: `stripVariantTokens` assembles a residual only out of
 * words it split on whitespace and kept as non-empty, then trims the result,
 * so a non-empty residual cannot begin with a space. Either step alone is
 * enough; both would have to be abandoned before a real title could reach
 * this key.
 *
 * Resist the urge to harden this with an unprintable character. A NUL byte is
 * the tempting choice and it is strictly weaker — a title can carry a NUL and
 * keep it through stripping — and a NUL in the source makes git treat this
 * whole file as binary, so a change to it shows up as a byte count instead of
 * a diff nobody can review.
 */
const UNMERGEABLE_KEY_PREFIX = ' '

/**
 * The logical products in a set of rows.
 *
 * A row that matches nothing is its own logical product of one, which is the
 * ordinary case: most stores publish most products once.
 */
export function detectLogicalProducts(
  products: readonly ProductAttributes[],
): readonly LogicalProduct[] {
  const byResidual = new Map<string, ProductAttributes[]>()
  const stripped = new Map<string, StrippedTitle>()

  for (const product of products) {
    const strip = stripVariantTokens(product.title)
    stripped.set(product.productId, strip)
    const key =
      strip.residual === ''
        ? `${UNMERGEABLE_KEY_PREFIX}${product.productId}`
        : strip.residual
    const bucket = byResidual.get(key)
    if (bucket) bucket.push(product)
    else byResidual.set(key, [product])
  }

  const groups: LogicalProduct[] = []
  for (const [key, candidates] of byResidual) {
    const residualTitle = key.startsWith(UNMERGEABLE_KEY_PREFIX) ? '' : key
    if (candidates.length === 1) {
      groups.push({ residualTitle, memberIds: [candidates[0]!.productId], axes: [] })
      continue
    }

    // Every candidate is compared against the group's anchor rather than
    // against each other, so the merge cannot chain: A merging with B and B
    // with C must not drag A and C together when they do not agree.
    const anchor = candidates[0]!
    const merged: ProductAttributes[] = [anchor]
    const rejected: ProductAttributes[] = []
    for (const candidate of candidates.slice(1)) {
      // Compared on everything *except* the variant words, because differing on
      // those is the whole premise: "Trailblazer — Red" and "— Blue" disagree
      // about colour by definition, and counting that as disagreement would
      // make the check reject exactly the case it exists to recognise.
      const similarity = attributeSimilarity(
        withoutVariantTokens(anchor),
        withoutVariantTokens(candidate),
      )
      if (similarity.valueAgreement >= SPLIT_VARIANT_AGREEMENT_MIN) merged.push(candidate)
      else rejected.push(candidate)
    }

    groups.push({
      residualTitle,
      memberIds: merged.map((product) => product.productId),
      axes: variantAxesOf(merged.map((product) => stripped.get(product.productId)!)),
    })
    for (const outsider of rejected) {
      groups.push({ residualTitle, memberIds: [outsider.productId], axes: [] })
    }
  }

  return groups
}

/**
 * The same product with its variant axes set aside, for a comparison that is
 * about whether two rows are the same product rather than about which colour
 * each one is.
 *
 * Both the words taken out of the title and the store's own option definitions
 * go, and for one reason: they are the axes a split variant differs along by
 * definition. "Trailblazer — Red" with an option `Colour: Red` and "— Blue"
 * with `Colour: Blue` disagree about colour because they are two colours of one
 * shoe, and letting that count as disagreement would make the check reject
 * exactly the case it exists to recognise.
 */
function withoutVariantTokens(product: ProductAttributes): ProductAttributes {
  const attributes = new Map(product.attributes)
  const sources = new Map(product.sources)
  for (const [name, source] of product.sources) {
    if (source !== 'variant_token' && source !== 'product_option') continue
    attributes.delete(name)
    sources.delete(name)
  }
  return { ...product, attributes, sources }
}

/** The variant classes a merged group's members actually differ along. */
function variantAxesOf(members: readonly StrippedTitle[]): readonly string[] {
  const values = new Map<string, Set<string>>()
  for (const member of members) {
    for (const token of member.tokens) {
      const bucket = values.get(token.name) ?? new Set<string>()
      bucket.add(token.value)
      values.set(token.name, bucket)
    }
  }
  return [...values.entries()]
    .filter(([, bucket]) => bucket.size > 1)
    .map(([name]) => name)
    .sort()
}

/** The variant words a single product's title carried, as named attributes. */
export function variantTokensOf(title: string): readonly AttributeValue[] {
  return stripVariantTokens(title).tokens
}
