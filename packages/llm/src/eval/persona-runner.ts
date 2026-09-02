import {
  buildPersona,
  describesTheStore,
  emptyFactSheet,
  storeVocabulary,
  timezoneForCountry,
  UnrecordedSpend,
  type FactSheet,
  type LlmClient,
  type PosthogCapture,
} from '@sortiva/core'
import { AnthropicLlmClient } from '../client'
import { loadPrompt } from '../prompts'
import type { EvalRunner } from './runner'

/**
 * What `persona.smoke` runs: one known store in, its language, its country, the
 * clock it would publish on, and a verdict on whether the description describes
 * anything.
 *
 * The set grades two different things and they fail differently. Language and
 * country are decided by a chain of evidence rather than by the model, so they
 * are asserted **exactly** — an inexact answer there is not a worse answer, it
 * is another country's search data bought under this store's name. The
 * description is the model's own work and cannot be matched against a gold
 * paragraph, so it is graded on whether it is degenerate: empty, a label, the
 * brief handed back, or the kind of sentence that would be true of any shop.
 *
 * Ten stores, in seven languages, exercising every link of the chain —
 * the shop's own settings, a `lang` attribute, agreeing `hreflang` tags, a
 * single-country currency, and a country suffix on the address — plus two of
 * the countries whose publish clock is a choice rather than a fact.
 */

/** One case's input: a store as onboarding would have it by the time the persona runs. */
export interface PersonaEvalInput {
  readonly domain: string
  /** What the merchant configured, where the case is testing that link. */
  readonly shop?: {
    readonly primaryLocale?: string | null
    readonly countryCode?: string | null
    readonly currency?: string | null
  }
  /** The homepage as served, for its language tags. */
  readonly homepageHtml?: string
  readonly productCount: number
  readonly families: readonly {
    readonly name: string
    readonly memberCount: number
    readonly differentiationAxes?: readonly string[]
    /** Merged into an empty sheet, so a case names only the fields it cares about. */
    readonly facts?: Partial<FactSheet>
  }[]
  readonly topSellers?: readonly { readonly title: string; readonly rank: number }[]
  readonly pages?: readonly { readonly kind: 'homepage' | 'about'; readonly text: string }[]
  /** Free-text note on what the case is testing. Not read by the runner. */
  readonly note?: string
}

/** What a case is graded against. Compared to the runner's answer exactly. */
export interface PersonaEvalGold {
  readonly main_language: string
  readonly country: string
  readonly timezone: string
  /** `substantive`, or the way the description failed. */
  readonly description: string
}

/** The eval has no analytics project and no database; the spend it makes is the CI job's own bill. */
const UNRECORDED_CAPTURE: Pick<PosthogCapture, 'captureAiGeneration'> = {
  captureAiGeneration() {},
}

/**
 * The real client, deliberately.
 *
 * An eval that grades a stand-in grades nothing: the whole question is what
 * *this model* does with *this prompt*, so with no key the set fails loudly and
 * names what is missing rather than scoring a substitute and reporting a pass.
 */
function anthropicClient(): LlmClient {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'persona.smoke needs ANTHROPIC_API_KEY: it grades what the real model does with the real prompt, ' +
        'and a stand-in would report a pass that means nothing.',
    )
  }
  return new AnthropicLlmClient({ capture: UNRECORDED_CAPTURE, ledger: new UnrecordedSpend() })
}

/**
 * `client` is injectable so the set's own wiring — the detection chain, the
 * prompt, the scoring and the vocabulary the description is judged against —
 * can be proved in the ordinary test run, where calling a vendor is not an
 * option. `pnpm eval` passes nothing and gets the real model.
 */
export function personaEvalRunner(client?: LlmClient): EvalRunner {
  return async (input) => {
    const testCase = input as PersonaEvalInput
    const llm = client ?? anthropicClient()
    const prompt = loadPrompt('persona', 1)

    const result = await buildPersona(
      { llm, prompt: { version: prompt.version, text: prompt.text } },
      {
        // The eval has no account behind it. Attribution is required on every
        // call, so the set names itself rather than borrowing a real store's id.
        accountId: 'persona-smoke',
        domain: testCase.domain,
        brief: briefFrom(testCase),
        evidence: {
          ...(testCase.shop ? { shop: testCase.shop } : {}),
          ...(testCase.homepageHtml === undefined ? {} : { homepageHtml: testCase.homepageHtml }),
          domain: testCase.domain,
        },
      },
    )

    const graded: PersonaEvalGold = {
      main_language: result.persona.language,
      country: result.persona.country,
      timezone: timezoneForCountry(result.persona.country).timezone,
      description: describesTheStore(result.persona.description, vocabularyOf(testCase)),
    }
    return graded
  }
}

/** The catalogue as the persona brief needs it, with unnamed fact fields left empty. */
export function briefFrom(testCase: PersonaEvalInput) {
  return {
    productCount: testCase.productCount,
    families: testCase.families.map((family) => ({
      name: family.name,
      memberCount: family.memberCount,
      differentiationAxes: family.differentiationAxes ?? [],
      mergedFacts: { ...emptyFactSheet(), ...family.facts } as FactSheet,
    })),
    topSellers: testCase.topSellers ?? [],
    pages: testCase.pages ?? [],
  }
}

/**
 * The words a real description of this store would be expected to touch: its
 * family names and its best sellers. Deliberately not the categories the model
 * itself returned — grading an answer against another part of the same answer
 * would let a model agree with itself.
 */
export function vocabularyOf(testCase: PersonaEvalInput): string[] {
  return storeVocabulary([
    ...testCase.families.map((family) => family.name),
    ...(testCase.topSellers ?? []).map((seller) => seller.title),
  ])
}
