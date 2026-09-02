import type { LlmClient } from '../contracts/llm'
import type { PersonaBriefInput } from './brief'
import { detectLocale, type LocaleDetection, type LocaleEvidence } from './locale'
import { buildPersonaLlmRequest, type PersonaPrompt } from './prompt'
import type { Persona, PersonaDraft } from './schema'
import { timezoneForCountry, type TimezoneChoice } from './timezones'

/**
 * Building a store's business profile: one model call over what its catalogue
 * and its own pages say, with the two values that must not be guessed settled
 * before the call rather than by it.
 *
 * **Why the model does not decide the language and the country.** Both are
 * passed straight to the paid search-data vendor as its language and location
 * parameters, so a wrong value does not produce an error — it produces another
 * country's search volumes, and every judgement built on them is then confident
 * and wrong. The store's own Shopify setting, its `lang` attribute and its
 * `hreflang` tags are statements the merchant made; a model reading a catalogue
 * is inferring. So the detection chain wins wherever it produced an answer, and
 * the model's own reading is the last link rather than the first. It still
 * matters: a store whose settings, markup, currency and address all say nothing
 * has only the model's answer, and the alternative there is nothing at all.
 *
 * The merchant confirms or corrects all of it before anything is written
 * (onboarding's confirmation step), so a wrong answer here is recoverable — but
 * one nobody notices is not, which is why the profile records which link in the
 * chain produced each value.
 */

export interface PersonaDependencies {
  /** The single instrumented wrapper. Caching, cost recording and schema validation live inside it. */
  readonly llm: LlmClient
  readonly prompt: PersonaPrompt
}

export interface PersonaInput {
  readonly accountId: string
  readonly domain: string
  /** Everything about the catalogue the call is told. Families, never products' words. */
  readonly brief: Omit<PersonaBriefInput, 'domain' | 'locale'>
  /** What the store's settings, markup and address say about where it is. */
  readonly evidence: LocaleEvidence
}

export interface PersonaResult {
  readonly persona: Persona
  /** What the chain concluded before the call, kept so a disagreement is visible. */
  readonly detection: LocaleDetection
  /** The publish clock that follows from the country. */
  readonly timezone: TimezoneChoice
  /** True when the wrapper replayed a stored completion instead of calling the model. */
  readonly cacheHit: boolean
}

export async function buildPersona(
  deps: PersonaDependencies,
  input: PersonaInput,
): Promise<PersonaResult> {
  const detection = detectLocale(input.evidence)

  const result = await deps.llm.complete<PersonaDraft>(
    buildPersonaLlmRequest({
      prompt: deps.prompt,
      accountId: input.accountId,
      domain: input.domain,
      brief: { ...input.brief, domain: input.domain, locale: detection },
    }),
  )

  const draft = result.output
  const language = detection.language ?? draft.main_language.toLowerCase()
  const country = detection.country ?? draft.country.toUpperCase()

  return {
    persona: {
      description: draft.business_description.trim(),
      productCategories: draft.product_categories
        .map((category) => category.trim())
        .filter((category) => category !== ''),
      language,
      country,
      audience: draft.audience.trim(),
      tone: draft.brand_tone.trim(),
      languageSource: detection.languageSource ?? 'model',
      countrySource: detection.countrySource ?? 'model',
      promptVersion: result.promptVersion,
      modelId: result.modelId,
    },
    detection,
    timezone: timezoneForCountry(country),
    cacheHit: result.cacheHit,
  }
}
