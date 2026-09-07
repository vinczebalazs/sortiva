import {
  namedOptionAxes,
  type ProductMetafield,
  type ProductOption,
} from '../catalog/products'
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
 *  - **the store's own option definitions** — "Size: S/M/L" — where the axis
 *    name and its values are both the merchant's, stated in a structured field
 *    rather than inferred from anything. The strongest source there is;
 *  - **the store's own metafields**, where a merchant keeps attributes Shopify
 *    has no field for. Only the ones the store itself declared to be a line of
 *    text are read, for the reason above: an app's stored rating count is not
 *    an axis and would make a nonsense of a comparison table;
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
export type AttributeSource =
  | 'fact_sheet'
  | 'tag'
  | 'variant_token'
  | 'product_option'
  | 'metafield'

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
  /**
   * The store's own option definitions. Empty for a store that keeps its
   * attributes elsewhere, and for a product last read before the catalogue sync
   * began asking Shopify for them.
   */
  readonly options?: readonly ProductOption[]
  /** The store's own metafields, unfiltered — the filtering happens here. */
  readonly metafields?: readonly ProductMetafield[]
}

/**
 * The metafield types whose value is a line of text a person wrote.
 *
 * Shopify's metafield types say how to read a value, and most of them are not
 * attributes at all: a `json` is a document, a `rating` and a `dimension` are
 * objects with their own fields, a `*_reference` is an internal id, a
 * `rich_text_field` is a formatted tree. Reading those as attribute values
 * would put `{"value":4.7,"scale_max":5}` or `gid://shopify/Product/12` on a
 * merchant's comparison table. So the list is the two that are text and
 * nothing else, and a metafield whose store did not declare a type at all is
 * skipped rather than guessed at.
 */
const ATTRIBUTE_METAFIELD_TYPES: Readonly<Record<string, 'one' | 'list'>> = {
  single_line_text_field: 'one',
  'list.single_line_text_field': 'list',
}

/**
 * How long a metafield value may be before it stops being an attribute.
 *
 * An axis value is a word or a short phrase — "trail", "wide fit", "made in
 * Portugal". Past this it is a sentence, and a sentence as a comparison-table
 * heading value is the same failure `verifiable_claims` is kept out of axes
 * for: true, unique to one product, and useless to compare. Raising it lets
 * longer values through and makes family axes wordier; lowering it drops
 * legitimate two- or three-word values. UNCALIBRATED.
 */
const METAFIELD_VALUE_MAX_CHARS = 60

/**
 * How many metafield-named attributes one product may contribute.
 *
 * Similarity is measured over the *names* two products share as a fraction of
 * all the names either holds, so a store that keeps fifty metafields on every
 * product would drown out the handful of facts we read from its descriptions
 * and every product would look like every other. The merchant's own ordering
 * is kept, so the ones they defined first survive. UNCALIBRATED.
 */
const METAFIELD_ATTRIBUTES_MAX = 12

/** One metafield read as an attribute, or nothing if it is not one. */
export function metafieldAttribute(
  metafield: ProductMetafield,
): { name: string; values: readonly string[] } | undefined {
  const shape = metafield.type === null ? undefined : ATTRIBUTE_METAFIELD_TYPES[metafield.type]
  if (shape === undefined) return undefined

  const name = normalizeAttributeName(metafield.key)
  if (name === '') return undefined

  const values = shape === 'list' ? parseTextList(metafield.value) : [metafield.value]
  const usable = values
    .map((value) => value.trim())
    .filter(
      (value) =>
        value !== '' && value.length <= METAFIELD_VALUE_MAX_CHARS && !value.includes('\n'),
    )
  if (usable.length === 0) return undefined
  return { name, values: usable }
}

/**
 * A list metafield's value, which Shopify stores as a JSON array in a string.
 *
 * A value that does not parse is not an error worth raising: it is one
 * merchant's field we cannot read, and the honest result is to know nothing
 * about it rather than to store the raw JSON as though it were a word.
 */
function parseTextList(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    return []
  }
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
 * The store's own option definitions win over everything, for the same reason
 * one step further: nothing about them was inferred at all.
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

  for (const option of namedOptionAxes(input.options)) {
    // Every value of the axis, because they are all true of this one product: a
    // shoe offered in three sizes is all three, and picking one would be
    // choosing a variant on the merchant's behalf.
    add(normalizeAttributeName(option.name), option.values, 'product_option')
  }

  let fromMetafields = 0
  for (const metafield of input.metafields ?? []) {
    if (fromMetafields >= METAFIELD_ATTRIBUTES_MAX) break
    const attribute = metafieldAttribute(metafield)
    // The key alone names the axis, not the namespace: `custom.terrain` reads
    // as "terrain" on a comparison table, which is what a merchant meant by it.
    // Two namespaces using one key therefore collide, and the first wins.
    if (!attribute || attributes.has(attribute.name)) continue
    add(attribute.name, attribute.values, 'metafield')
    fromMetafields += 1
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
