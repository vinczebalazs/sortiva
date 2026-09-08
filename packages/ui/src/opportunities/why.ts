import { criteriaNamed, t as defaultTranslate, type StringKey, type Translate } from '../strings'
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
  // Why a topic was held back for a catalogue that does not yet say enough
  // about itself. Same arrangement and the same reason: the sentence is one the
  // product may not reword, so the calendar day and the held article both reach
  // the single copy of it rather than each holding one.
  'quality_rejection.insufficient_richness': 'appendixA.qualityRejectionRichness' as StringKey,
  // Gate 1 stops a topic for the same two things the two sentences above were
  // approved for, so it points at them rather than saying the same thing in
  // slightly different words on a second screen. `held_insufficient_substance`
  // is the store not yet describing its products in enough detail to write
  // from; `converted_existing_target_optimize` is a page of the merchant's own
  // already ranking, which is the exact case that why-line was written for.
  'gate1.held_insufficient_substance': 'appendixA.qualityRejectionRichness' as StringKey,
  'gate1.converted_existing_target_optimize': 'appendixA.existingPageWhyLine' as StringKey,
}

/**
 * Families of key the catalogue files under their own name rather than under
 * `template.`.
 *
 * Every reason the weekly scan produces is written as `template.<signal>.<action>`,
 * and for a long time that was the only shape, so the lookup simply prefixed
 * everything. The sentences explaining a quality gate were written under their
 * bare key instead — `gate3.below_quality_bar` and ten siblings — which meant
 * eleven finished sentences sat in the catalogue that no screen could reach,
 * and every merchant whose article was held back read "the reasoning for this
 * one isn't available yet".
 *
 * `gate1.`, `gate2.` and `topic.` are listed alongside `gate3.` because they
 * come from the same producers and belong in the same place. Their sentences
 * are written now too, so all five namespaces resolve to real copy.
 *
 * Bare `gate.` holds what is true of a held day whichever check stopped it —
 * today only the admission that the row recorded no reason of its own. It is
 * kept apart from the numbered namespaces exactly because a sentence there must
 * not read as one particular check's finding.
 *
 * The last four are the same fault found again, in four more places. Each of
 * those families was written into the catalogue under its finished name by code
 * that had no reason to think of it as a "reason key" at all:
 *
 * - `optimize.` — the sentence a merchant reads when we could not produce safe
 *   advice for one of their pages. It was reaching them as the admission.
 * - `appendixA.` — the sentences the product may not reword. One of them, the
 *   outage line, is handed to the screen when a topic a merchant typed in
 *   cannot be classified, and it has to arrive word for word or not at all.
 * - `fix.` — the consolidation advice, whose lines sit beside headings the
 *   screen looks up directly, so both halves have to share one spelling.
 * - `email.` — the monthly summary names a held topic's reason by its
 *   catalogue key. Nothing renders those through here today; it is listed so
 *   this function answers for every explanation key in the product rather than
 *   for most of them, which is what lets the guard trust it alone.
 *
 * A family missing from this list is not a crash and not a blank space. It is a
 * merchant quietly reading "the reasoning for this one isn't available yet"
 * over a sentence that was written for them.
 */
const CATALOG_NAMESPACES: readonly string[] = [
  'gate.',
  'gate1.',
  'gate2.',
  'gate3.',
  'topic.',
  'optimize.',
  'appendixA.',
  'fix.',
  'email.',
]

/** Where an engine template key lives in the catalogue. */
export function catalogKeyFor(templateKey: string): string {
  const alias = ALIASES[templateKey]
  if (alias) return alias
  if (CATALOG_NAMESPACES.some((namespace) => templateKey.startsWith(namespace))) return templateKey
  return `template.${templateKey}`
}

/**
 * Values that arrive as the engine's own name for something rather than as a
 * measurement, and the catalogue lookup that turns each into words.
 *
 * Nearly everything a why-line interpolates is a number, and a number reads the
 * same in every language. `failed_criteria` is the exception: it arrives as the
 * quality judge's own identifiers, so a merchant whose article was held back
 * read "didn't meet our bar on informationGain".
 *
 * It is mapped here, in the one function every why-line goes through, for two
 * reasons. The producing side cannot do it — a gate and a route handler have no
 * idea which language the store reads, and putting the words there would put
 * copy outside the catalogue. And a screen doing it for itself is how the
 * article page came to name these correctly while the calendar did not.
 */
const LABELLED_PARAMS: Readonly<
  Record<string, (value: string | number, t: Translate) => string>
> = {
  failed_criteria: criteriaNamed,
}

function inMerchantWords(params: TemplatedLine['params'], t: Translate): TemplatedLine['params'] {
  let mapped: Record<string, string | number> | null = null
  for (const [name, label] of Object.entries(LABELLED_PARAMS)) {
    const value = params[name]
    if (value === undefined) continue
    mapped ??= { ...params }
    mapped[name] = label(value, t)
  }
  return mapped ?? params
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
 * a raw key such as `striking_distance.optimize` on screen would be worse than
 * saying nothing useful honestly.
 */
export function renderTemplatedLine(
  line: TemplatedLine | null | undefined,
  t: Translate = defaultTranslate,
): RenderedLine {
  if (!line) return { text: t('opportunities.whyUnavailable' as StringKey), known: false }
  const key = catalogKeyFor(line.templateKey)
  try {
    return { text: t(key as StringKey, inMerchantWords(line.params, t)), known: true }
  } catch {
    return { text: t('opportunities.whyUnavailable' as StringKey), known: false }
  }
}

/** The why-line as a bare string, for the places that only render text. */
export function whyLine(line: TemplatedLine | null | undefined, t: Translate = defaultTranslate): string {
  return renderTemplatedLine(line, t).text
}
