import type { FactSheet } from '../distill/schema'

/**
 * What a product *is*, expressed as named attributes with values — the shape
 * everything about grouping is decided on.
 *
 * The names matter as much as the values. A family's differentiation axes are
 * shown to the merchant as tags, are what a buying guide's sections are built
 * from ("by terrain / for wide feet"), and are seed material for keyword
 * research. An axis called `option_2` would be worse than no axis at all, so
 * every name here comes from somewhere that named it:
 *
 *  - **the fact sheet**, whose ten fields we named ourselves and whose values
 *    were extracted from the merchant's own description;
 *  - **the merchant's own tags**, where they are written `terrain:trail` — the
 *    key is the merchant's word for the axis, not ours;
 *  - **the variant token classes** (`color`, `size`) that the split-variant
 *    merge recognises in a title, where the class is what the merge stripped.
 *
 * Nothing here is inferred. A product states an attribute or it does not, and a
 * product stating nothing contributes nothing — which is exactly what the
 * sparse-product guardrail is built to notice.
 */

/**
 * The fact-sheet fields that can be an axis.
 *
 * `verifiable_claims` is deliberately absent. Its entries are sentences —
 * "waterproof to 10m" — so no two products ever hold the same one and every
 * family would report it as the axis they all differ along, which is true and
 * useless. It still counts towards a family's substance; it just cannot be a
 * comparison heading.
 */
export const AXIS_FACT_FIELDS = [
  'material',
  'dimensions',
  'weight',
  'capacity',
  'compatibility',
  'use_cases_stated',
  'care',
  'certifications',
  'origin',
] as const

/** Where one attribute name came from, kept so a wrong axis can be traced to what named it. */
export type AttributeSource = 'fact_sheet' | 'tag' | 'variant_token'

export interface AttributeValue {
  readonly name: string
  readonly value: string
  readonly source: AttributeSource
}

/** One product as grouping sees it: no description, no prose, only named attributes. */
export interface ProductAttributes {
  readonly productId: string
  readonly title: string
  /** The merchant's own taxonomy for this product, already blocklist-filtered. */
  readonly taxonomyKey: string | null
  /** Attribute name → the values this product states for it, sorted and de-duplicated. */
  readonly attributes: ReadonlyMap<string, readonly string[]>
  /** Where each attribute name came from. */
  readonly sources: ReadonlyMap<string, AttributeSource>
  /** How many of the sheet's ten extractable fields the description supported. The sparse guardrail reads this. */
  readonly populatedFields: number
  readonly factCount: number
}

export interface ProductAttributeInput {
  readonly productId: string
  readonly title: string
  readonly factSheet: FactSheet
  readonly populatedFields: number
  /** The merchant's tags, exactly as Shopify gave them. */
  readonly tags?: readonly string[]
  /** Taxonomy this product was placed in, after the promo blocklist has had its say. */
  readonly taxonomyKey?: string | null
  /** Variant token classes and values the split-variant merge stripped out of the title. */
  readonly variantTokens?: readonly AttributeValue[]
}

/**
 * A merchant's tag written as a key and a value — `terrain:trail`,
 * `width=wide`.
 *
 * Shopify gives tags no structure at all: they are a comma-separated string,
 * and a store using them as attributes is following a convention rather than a
 * feature. So this recognises the convention where it is present and ignores
 * the tag entirely where it is not — a bare `sale` tag names no axis, and
 * pretending it does would put "sale" on a comparison table.
 */
export function parseKeyedTag(tag: string): { name: string; value: string } | undefined {
  const separator = tag.search(/[:=]/)
  if (separator <= 0) return undefined
  const name = normalizeAttributeName(tag.slice(0, separator))
  const value = tag.slice(separator + 1).trim()
  if (name === '' || value === '') return undefined
  return { name, value: value.toLowerCase() }
}

/** One spelling per attribute name, so `Terrain`, `terrain` and `Terrain ` are one axis. */
export function normalizeAttributeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '_')
}

/**
 * Everything we can name about one product, from the three sources above.
 *
 * The merchant's tags win a name collision with the fact sheet: a store that
 * has tagged `material:leather` has said so deliberately and in their own
 * vocabulary, where the sheet's `material` was read out of prose by a model.
 */
export function productAttributes(input: ProductAttributeInput): ProductAttributes {
  const attributes = new Map<string, string[]>()
  const sources = new Map<string, AttributeSource>()

  const add = (name: string, values: readonly string[], source: AttributeSource): void => {
    const cleaned = values.map((value) => value.trim().toLowerCase()).filter((value) => value !== '')
    if (cleaned.length === 0) return
    const existing = attributes.get(name)
    if (existing && sources.get(name) !== source) {
      // A name already claimed by a more authoritative source stays as it is.
      return
    }
    attributes.set(name, [...new Set([...(existing ?? []), ...cleaned])].sort())
    sources.set(name, source)
  }

  for (const value of input.variantTokens ?? []) {
    add(value.name, [value.value], 'variant_token')
  }

  for (const tag of input.tags ?? []) {
    const keyed = parseKeyedTag(tag)
    if (keyed) add(keyed.name, [keyed.value], 'tag')
  }

  for (const field of AXIS_FACT_FIELDS) {
    if (attributes.has(field)) continue
    const value = input.factSheet[field]
    if (Array.isArray(value)) add(field, value, 'fact_sheet')
    else if (typeof value === 'string') add(field, [value], 'fact_sheet')
  }

  return {
    productId: input.productId,
    title: input.title,
    taxonomyKey: input.taxonomyKey ?? null,
    attributes,
    sources,
    populatedFields: input.populatedFields,
    factCount: input.factSheet.fact_count,
  }
}

/**
 * How alike two products are, as two separate numbers rather than one.
 *
 * They are separate because a family is defined by a specific relationship:
 * products whose attribute sets *match except along one or more axes*. That is
 * two claims, and blending them into one score would let either stand in for
 * the other.
 *
 *  - **`nameOverlap`** — do the two describe themselves in the same terms at
 *    all? A shoe stating terrain, drop and width and a candle stating scent and
 *    burn time have nothing to compare, whatever their values.
 *  - **`valueAgreement`** — of the terms they share, how many do they agree on?
 *    High agreement with a handful of exceptions is a family, and those
 *    exceptions are its axes. Near-zero agreement is two different things that
 *    happen to be described the same way.
 *
 * Products naming nothing in common score zero on both rather than one. Two
 * empty sheets are not the same product; they are two products we know nothing
 * about, and reading "unknown" as "same" is exactly what the sparse-product
 * guardrail exists to prevent.
 */
export interface AttributeSimilarity {
  readonly nameOverlap: number
  readonly valueAgreement: number
  /** The names they share but disagree on — a candidate axis for the family they might form. */
  readonly differingNames: readonly string[]
}

export function attributeSimilarity(
  a: ProductAttributes,
  b: ProductAttributes,
): AttributeSimilarity {
  const union = new Set([...a.attributes.keys(), ...b.attributes.keys()])
  if (union.size === 0) return { nameOverlap: 0, valueAgreement: 0, differingNames: [] }

  const shared: string[] = []
  const differing: string[] = []
  for (const name of union) {
    const left = a.attributes.get(name)
    const right = b.attributes.get(name)
    if (!left || !right) continue
    shared.push(name)
    if (!left.some((value) => right.includes(value))) differing.push(name)
  }

  return {
    nameOverlap: shared.length / union.size,
    valueAgreement: shared.length === 0 ? 0 : (shared.length - differing.length) / shared.length,
    differingNames: differing.sort(),
  }
}
