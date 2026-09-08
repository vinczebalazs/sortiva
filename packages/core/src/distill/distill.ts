import { namedOptionAxes, type ProductOption } from '../catalog/products'
import type { LlmClient } from '../contracts/llm'
import { DISTILL_MIN_INPUT_CHARS } from './limits'
import { buildDistillLlmRequest, type DistillPrompt } from './prompt'
import {
  countFacts,
  countPopulatedFields,
  emptyFactSheet,
  EXTRACTED_FIELDS,
  type ExtractedFacts,
  type FactSheet,
} from './schema'

/**
 * One product, distilled: the facts its own words support, plus the structured
 * data that was already factual and needed no model at all.
 *
 * The whole point of the step is what it *stops*. A merchant's description is
 * mostly register — "effortlessly elevate your everyday carry" — and feeding
 * that into what we later write poisons the result twice: keywords derived from
 * adjectives instead of attributes, and articles that inherit the register and
 * then fail our own quality gate for sounding like an advert. So the
 * description is read exactly once, here, and only this object leaves.
 */

export interface DistillDependencies {
  /** The single instrumented wrapper. Caching, cost recording and schema validation live inside it. */
  readonly llm: LlmClient
  readonly prompt: DistillPrompt
}

/** One product as the distillation reads it. The description arrives as plain text; the stored HTML never leaves the catalogue repository. */
export interface DistillableProduct {
  readonly productId: string
  readonly title: string
  readonly descriptionText: string
  /** Merged in as-is: already factual, so it costs nothing and cannot be got wrong. */
  readonly priceRange: { readonly min: number; readonly max: number } | null
  /**
   * The store's own option axes, merged in on the same footing as the price.
   * Absent for a store that defines none, which is ordinary and not a failure.
   */
  readonly options?: readonly ProductOption[]
}

export interface DistillationResult {
  readonly productId: string
  readonly factSheet: FactSheet
  /** How many of the ten extractable fields the description supported. What the richness roll-up reads. */
  readonly populatedFields: number
  /** Stamped on the stored sheet, so any fact can be traced to the prompt and model that produced it. */
  readonly promptVersion: string
  readonly modelId: string
  /** True when the wrapper replayed a stored completion instead of calling the model. */
  readonly cacheHit: boolean
  /** False when the description was too thin to be worth a call. */
  readonly modelCalled: boolean
}

/**
 * What `model_id` says on a sheet no model produced.
 *
 * A product with a two-word description has nothing to extract, so no call is
 * made and there is no model to name. Recording a model that was never asked
 * would make the emptiest sheets in the store indistinguishable from a model
 * that answered with nothing.
 */
export const DISTILL_NO_MODEL = 'none'

export async function distillProduct(
  deps: DistillDependencies,
  input: {
    readonly accountId: string
    readonly domain?: string
    readonly product: DistillableProduct
  },
): Promise<DistillationResult> {
  const { product } = input
  const text = product.descriptionText.trim()

  if (text.length < DISTILL_MIN_INPUT_CHARS) {
    return {
      productId: product.productId,
      factSheet: {
        ...emptyFactSheet(),
        price_range: product.priceRange,
        variant_axes: axisNames(product.options),
      },
      populatedFields: 0,
      promptVersion: deps.prompt.version,
      modelId: DISTILL_NO_MODEL,
      cacheHit: false,
      modelCalled: false,
    }
  }

  const result = await deps.llm.complete<ExtractedFacts>(
    buildDistillLlmRequest({
      prompt: deps.prompt,
      accountId: input.accountId,
      ...(input.domain === undefined ? {} : { domain: input.domain }),
      title: product.title,
      descriptionText: text,
    }),
  )

  const extracted = normalise(result.output)
  return {
    productId: product.productId,
    factSheet: {
      ...extracted,
      // Merged, not extracted: the price is already a number in our own
      // database, and a model asked for one would sooner or later invent one.
      price_range: product.priceRange,
      // The merchant's own names for the ways their product varies. Merged, not
      // extracted: they are a structured field the store filled in, and a model
      // asked to name an axis would sooner or later name one nobody chose.
      variant_axes: axisNames(product.options),
      fact_count: countFacts(extracted),
    },
    populatedFields: countPopulatedFields(extracted),
    promptVersion: result.promptVersion,
    modelId: result.modelId,
    cacheHit: result.cacheHit,
    modelCalled: true,
  }
}

/**
 * Tidies what the model returned without changing what it says.
 *
 * Models return `""` where they mean "nothing" often enough that treating the
 * two differently would put empty strings into fact sheets and make a product
 * that stated nothing look like one that stated a blank. Whitespace is trimmed,
 * empty entries dropped, and repeated entries collapsed — a description that
 * says "waterproof" twice states one fact.
 */
function normalise(output: ExtractedFacts): ExtractedFacts {
  const result = {} as Record<string, unknown>
  for (const field of EXTRACTED_FIELDS) {
    const value = output[field]
    if (Array.isArray(value)) {
      const cleaned: string[] = []
      const seen = new Set<string>()
      for (const entry of value) {
        const trimmed = typeof entry === 'string' ? entry.trim() : ''
        if (trimmed === '') continue
        const key = trimmed.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        cleaned.push(trimmed)
      }
      result[field] = cleaned
    } else {
      const trimmed = typeof value === 'string' ? value.trim() : ''
      result[field] = trimmed === '' ? null : trimmed
    }
  }
  result.fluff_discarded = output.fluff_discarded === true
  return result as unknown as ExtractedFacts
}

/**
 * The axis names for the sheet: the merchant's own words, placeholder dropped.
 *
 * Only the names, not the values. A sheet describes one product and every value
 * of an axis belongs to it, so listing them would say a shoe is red *and* blue.
 * What the sheet records is that colour is a way this product varies.
 */
function axisNames(options: readonly ProductOption[] | undefined): readonly string[] {
  return namedOptionAxes(options).map((option) => option.name)
}
