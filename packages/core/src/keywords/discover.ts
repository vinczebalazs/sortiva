import type { LlmClient } from '../contracts/llm'
import type { KeywordMetric } from '../contracts/seo'
import type { SeedBriefInput } from './brief'
import { buildSeedKeywordsLlmRequest, type SeedKeywordsPrompt } from './prompt'
import type { SeedKeywordsDraft } from './schema'
import { validateKeywordTerm } from './validate'

/**
 * The two steps of keyword discovery that are ours rather than a vendor's:
 * asking for candidate search terms, and deciding which of them survive.
 *
 * Everything in between — pricing the candidates, reading results pages — is a
 * paid vendor call and lives in the job that pays for it. What is here is the
 * part that has to be the same however it is driven, and the part worth testing
 * without a network.
 */

export interface SeedKeywordsDependencies {
  /** The single instrumented wrapper. Caching, cost recording and schema validation live inside it. */
  readonly llm: LlmClient
  readonly prompt: SeedKeywordsPrompt
}

export interface SeedKeywordsInput {
  readonly accountId: string
  readonly domain: string
  readonly brief: SeedBriefInput
  /** From `packages/rules`: how many candidates to keep out of the answer, at most. */
  readonly candidatesMax: number
}

export interface SeedKeywordsResult {
  readonly terms: readonly string[]
  readonly promptVersion: string
  readonly modelId: string
  /** True when the wrapper replayed a stored completion instead of calling the model. */
  readonly cacheHit: boolean
}

/**
 * One model call, then a clean-up that costs nothing and prevents a bill.
 *
 * Every term that survives here is bought from the search-data vendor, so
 * duplicates are not untidiness — "Running Shoes" and "running  shoes" are one
 * question asked twice, and the vendor would price both. Normalising and
 * de-duplicating before the ceiling is applied also means the ceiling counts
 * distinct terms rather than distinct strings.
 */
export async function deriveSeedKeywords(
  deps: SeedKeywordsDependencies,
  input: SeedKeywordsInput,
): Promise<SeedKeywordsResult> {
  const result = await deps.llm.complete<SeedKeywordsDraft>(
    buildSeedKeywordsLlmRequest({
      prompt: deps.prompt,
      accountId: input.accountId,
      domain: input.domain,
      brief: input.brief,
    }),
  )

  const seen = new Set<string>()
  const terms: string[] = []
  for (const candidate of result.output.keywords) {
    const validated = validateKeywordTerm(candidate)
    if (!validated.ok) continue
    if (seen.has(validated.term)) continue
    seen.add(validated.term)
    terms.push(validated.term)
    if (terms.length >= input.candidatesMax) break
  }

  return {
    terms,
    promptVersion: result.promptVersion,
    modelId: result.modelId,
    cacheHit: result.cacheHit,
  }
}

export interface DraftKeyword {
  readonly term: string
  readonly monthlySearchVolume: number | null
  /**
   * How hard the term looks to rank for, on a 0–100 scale. The vendor reports
   * ad competition on a 0–1 scale, which is the closest thing it gives us; the
   * conversion is here so the column means one thing.
   */
  readonly difficulty: number | null
  readonly cpcUsd: number | null
}

/**
 * Which priced candidates become the store's draft keyword set.
 *
 * Ordered by search volume, highest first, and cut at the ceiling. A term the
 * vendor could not price at all sorts last rather than being discarded: no
 * volume usually means a phrase too specific for the vendor's panel rather than
 * a phrase nobody searches, and the merchant may well recognise it as exactly
 * what their customers say. It is still cut if better-evidenced terms fill the
 * set first.
 *
 * Deliberately not filtered against the demand floor in `packages/rules`. That
 * floor decides whether a topic is worth *an article*, which is a later and
 * more expensive question; a keyword below it is still a true fact about the
 * store's market and still belongs on the confirmation screen.
 */
export function pickDraftKeywords(
  metrics: readonly KeywordMetric[],
  keepMax: number,
): DraftKeyword[] {
  const byTerm = new Map<string, DraftKeyword>()

  for (const metric of metrics) {
    const validated = validateKeywordTerm(metric.keyword)
    if (!validated.ok) continue
    if (byTerm.has(validated.term)) continue
    byTerm.set(validated.term, {
      term: validated.term,
      monthlySearchVolume: metric.monthlySearchVolume,
      difficulty: difficultyFromCompetition(metric.competition),
      cpcUsd: metric.cpcUsd,
    })
  }

  return [...byTerm.values()]
    .sort(
      (a, b) =>
        (b.monthlySearchVolume ?? -1) - (a.monthlySearchVolume ?? -1) ||
        a.term.localeCompare(b.term),
    )
    .slice(0, Math.max(0, keepMax))
}

/** The vendor's 0–1 ad competition as the 0–100 integer the column and the screen use. */
function difficultyFromCompetition(competition: number | null): number | null {
  if (competition === null || !Number.isFinite(competition)) return null
  return Math.round(Math.min(1, Math.max(0, competition)) * 100)
}
