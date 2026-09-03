import { accountAttribution } from '../contracts/analytics'
import type { LlmClient, LlmRequest } from '../contracts/llm'

/**
 * Subtopic coverage: what the pages ranking above ours settle for a buyer that
 * ours does not.
 *
 * This is the one model call in the OPTIMIZE path that looks at competitor
 * pages. It answers a comparison question — "what is on those pages and not on
 * this one" — and nothing else: it never decides whether the difference is
 * worth acting on, never proposes copy, and never sees the merchant's catalogue.
 *
 * Two of its rules exist because a model asked to compare will otherwise start
 * inventing. A subtopic it reports has to be attributed to pages we actually
 * fetched, by their exact addresses, or the attribution is dropped; and a
 * subtopic no fetched page covers is discarded outright, because "what a good
 * page would contain" is a different question we are not asking here.
 */

/** One page as the comparison sees it: what it says it covers, and the opening of what it actually says. */
export interface CoveragePage {
  readonly url: string
  readonly title: string | null
  readonly headings: readonly string[]
  /** The opening of the page's readable text, markup already stripped. */
  readonly excerpt: string
}

export interface CoverageCompetitorPage extends CoveragePage {
  readonly domain: string
  readonly position: number
}

export interface CoverageAnalysisInput {
  readonly accountId: string
  /** The search the comparison is about — the query cluster's head. */
  readonly query: string
  readonly ourPage: CoveragePage
  /** The fetched top-N ranking pages, best position first. */
  readonly competitors: readonly CoverageCompetitorPage[]
}

/** Where one ranking page covers a subtopic. */
export interface SubtopicCitation {
  readonly url: string
  /** The heading it sits under. Empty where the page covers it in running text. */
  readonly heading: string
}

/** One subtopic as the model reported it, after hallucinated addresses have been dropped. */
export interface SubtopicCoverage {
  readonly name: string
  readonly presentOnOurPage: boolean
  /** The heading or phrase on *our* page that covers it. Null when absent. */
  readonly ourEvidence: string | null
  readonly competitors: readonly SubtopicCitation[]
}

export interface CoverageAnalysis {
  readonly subtopics: readonly SubtopicCoverage[]
  /** How many ranking pages the comparison actually saw — the denominator the consensus floor is read against. */
  readonly topPagesAnalysed: number
  readonly modelId: string
  readonly promptVersion: string
  /** True when this replayed from the request cache, and so cost nothing. */
  readonly cacheHit: boolean
  readonly usdCost: number
}

/** The model's answer before any of it has been checked against the pages we fetched. */
export interface CoverageAnalysisOutput {
  readonly subtopics: readonly {
    readonly name: string
    readonly presentOnOurPage: boolean
    readonly ourEvidence: string | null
    readonly competitors: readonly { readonly url: string; readonly heading: string }[]
  }[]
}

export const COVERAGE_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subtopics'],
  properties: {
    subtopics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'presentOnOurPage', 'ourEvidence', 'competitors'],
        properties: {
          name: { type: 'string', minLength: 1 },
          presentOnOurPage: { type: 'boolean' },
          ourEvidence: { type: ['string', 'null'] },
          competitors: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['url', 'heading'],
              properties: {
                url: { type: 'string', minLength: 1 },
                heading: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
} as const

export interface CoveragePrompt {
  readonly version: string
  readonly text: string
}

function pageBlock(page: CoveragePage): string {
  return [
    `Title: ${page.title ?? '(none)'}`,
    `Headings: ${page.headings.join(' | ') || '(none)'}`,
    `Text: ${page.excerpt || '(empty)'}`,
  ].join('\n')
}

function competitorBlock(pages: readonly CoverageCompetitorPage[]): string {
  if (pages.length === 0) return '(no ranking pages were reachable)'
  return pages
    .map((page) => `${page.url} (${page.domain}, position ${page.position})\n${pageBlock(page)}`)
    .join('\n\n')
}

export function buildCoverageRequest(input: {
  readonly prompt: CoveragePrompt
  readonly analysis: CoverageAnalysisInput
}): LlmRequest {
  const { analysis } = input
  return {
    callType: 'intent_gap',
    promptVersion: input.prompt.version,
    system: input.prompt.text,
    messages: [
      {
        role: 'user',
        content: [
          `The search: ${analysis.query}`,
          '',
          `Our page — ${analysis.ourPage.url}`,
          pageBlock(analysis.ourPage),
          '',
          'The pages ranking for that search:',
          competitorBlock(analysis.competitors),
        ].join('\n'),
      },
    ],
    maxTokens: 4000,
    schema: COVERAGE_RESPONSE_SCHEMA,
    attribution: accountAttribution(analysis.accountId),
  }
}

/**
 * Keeps only what the fetched pages can support.
 *
 * An address the model did not receive is dropped rather than trusted: a
 * citation the merchant cannot click through to is worse than one fewer piece
 * of evidence. A subtopic left with no attribution at all disappears with it,
 * because a subtopic no ranking page covers is the model answering a question
 * we did not ask.
 */
export function groundSubtopics(
  output: CoverageAnalysisOutput,
  competitors: readonly CoverageCompetitorPage[],
): SubtopicCoverage[] {
  const known = new Set(competitors.map((page) => page.url))
  const out: SubtopicCoverage[] = []

  for (const subtopic of output.subtopics) {
    const seen = new Set<string>()
    const citations: SubtopicCitation[] = []
    for (const citation of subtopic.competitors) {
      if (!known.has(citation.url)) continue
      if (seen.has(citation.url)) continue
      seen.add(citation.url)
      citations.push({ url: citation.url, heading: citation.heading })
    }
    if (citations.length === 0) continue
    out.push({
      name: subtopic.name.trim(),
      presentOnOurPage: subtopic.presentOnOurPage,
      ourEvidence: subtopic.presentOnOurPage ? subtopic.ourEvidence : null,
      competitors: citations,
    })
  }

  return out
}

/**
 * The gap set: subtopics enough of the ranking pages settle and ours does not.
 *
 * The consensus floor is what stops one competitor's hobby-horse from becoming
 * work for the merchant — it lives in `packages/rules`, and this function only
 * reads it.
 */
export function gapSet(
  subtopics: readonly SubtopicCoverage[],
  presentOnTopPagesMin: number,
): SubtopicCoverage[] {
  return subtopics.filter(
    (subtopic) => !subtopic.presentOnOurPage && subtopic.competitors.length >= presentOnTopPagesMin,
  )
}

export interface AnalyseCoverageDeps {
  readonly llm: LlmClient
  readonly prompt: CoveragePrompt
}

/** The model call plus the grounding filter. The gap set is derived separately, so a threshold change re-derives from a cached analysis. */
export async function analyseCoverage(
  deps: AnalyseCoverageDeps,
  input: CoverageAnalysisInput,
  onRawOutput?: (output: CoverageAnalysisOutput) => Promise<void>,
): Promise<CoverageAnalysis> {
  const result = await deps.llm.complete<CoverageAnalysisOutput>(
    buildCoverageRequest({ prompt: deps.prompt, analysis: input }),
  )
  // Before the answer is picked over, so a crash between the model answering
  // and us finishing with it does not make us buy the same comparison twice.
  if (onRawOutput) await onRawOutput(result.output)

  return {
    subtopics: groundSubtopics(result.output, input.competitors),
    topPagesAnalysed: input.competitors.length,
    modelId: result.modelId,
    promptVersion: result.promptVersion,
    cacheHit: result.cacheHit,
    usdCost: result.usdCost,
  }
}
