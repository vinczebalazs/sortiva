import { t as defaultTranslate, type StringKey, type Translate } from '../strings'
import type { TemplatedLine } from './types'

/**
 * Every sentence explaining *why* something is an opportunity is looked up in
 * the string catalogue and filled with numbers the engine measured. Nothing a
 * language model wrote is ever shown here.
 *
 * That is not a style preference. A reason a model composed would read
 * beautifully and could quietly be wrong about the merchant's own store, and
 * there would be no way to tell from the screen which sentences were measured
 * and which were invented. So the engine sends a key and a bag of numbers, and
 * the words are ours.
 */

export type { TemplatedLine }

/**
 * Keys whose sentence already has a home elsewhere in the catalogue.
 *
 * The existing-page sentence is one of the dozen the product may not reword,
 * so it lives under its `appendixA.` key with the snapshot that holds it exact.
 * Pointing at it here rather than copying the words is what stops the two
 * drifting apart.
 */
const ALIASES: Readonly<Record<string, StringKey>> = {
  'existing_target.prefer_optimize': 'appendixA.existingPageWhyLine' as StringKey,
}

/** Where an engine template key lives in the catalogue. */
export function catalogKeyFor(templateKey: string): string {
  return ALIASES[templateKey] ?? `template.${templateKey}`
}

export interface RenderedLine {
  readonly text: string
  /** False when the catalogue has no sentence for this key, so a test can see the gap. */
  readonly known: boolean
}

/**
 * A key we have no sentence for renders a plain admission rather than the raw
 * key or an empty space. A new signal type shipping before its wording does is
 * a real possibility — the engine and this catalogue are different lanes — and
 * `striking_distance.page_one_intent_mismatch` on screen would be worse than
 * saying nothing useful honestly.
 */
export function renderTemplatedLine(
  line: TemplatedLine | null | undefined,
  t: Translate = defaultTranslate,
): RenderedLine {
  if (!line) return { text: t('opportunities.whyUnavailable' as StringKey), known: false }
  const key = catalogKeyFor(line.templateKey)
  try {
    return { text: t(key as StringKey, line.params), known: true }
  } catch {
    return { text: t('opportunities.whyUnavailable' as StringKey), known: false }
  }
}

/** The why-line as a bare string, for the places that only render text. */
export function whyLine(line: TemplatedLine | null | undefined, t: Translate = defaultTranslate): string {
  return renderTemplatedLine(line, t).text
}
