import { accountAttribution } from '../contracts/analytics'
import type { LlmClient, LlmRequest } from '../contracts/llm'
import type { StorePageType } from '../signals/types'
import { citableStoreFacts, type OptimizeEvidencePack } from './pack'

/**
 * The one model call that proposes edits to a merchant's own page.
 *
 * It sees the evidence pack and nothing else — no earlier attempt's reasoning,
 * no store data that is not in the pack, and never the raw page HTML the
 * catalogue holds. What comes back is checked against the pack by the lints in
 * `lints.ts` before anybody sees it; this file is only the asking.
 */

export interface RecommendationField {
  readonly current: string | null
  readonly suggested: string
  /**
   * One sentence from the model saying why the suggestion beats what is there.
   * Free prose, not a key into the copy catalogue, and shown to the merchant
   * exactly as the model wrote it — so every surface that renders it has to say
   * it was written by a model. Null when the model had nothing to add.
   */
  readonly rationale: string | null
}

/**
 * The model's sentence for one field, read from a stored recommendation.
 *
 * Recommendations generated before the field was renamed are stored under its
 * old name, `rationale_key`, and those rows are never rewritten — so anything
 * reading a recommendation back out of the database has to accept both spellings
 * or a merchant's older recommendation silently loses its explanation.
 */
export function fieldRationale(field: RecommendationField): string | null {
  if (field.rationale !== undefined) return field.rationale
  const legacy = (field as { readonly rationale_key?: string | null }).rationale_key
  return legacy ?? null
}

export interface RecommendationHeading {
  readonly op: 'add' | 'rewrite'
  readonly level: number
  readonly text: string
  /** The existing heading this should follow, or null for the top of the page. */
  readonly after: string | null
}

export interface RecommendationSection {
  readonly heading: string
  readonly suggested_copy: string
  /** Addresses from the pack. Anything else is not evidence, and the section goes with it. */
  readonly facts_used: readonly string[]
  /** Whether the ranking pages or the store's own facts are why this is missing. */
  readonly gap_source: 'serp' | 'store'
}

export interface RecommendationFaq {
  readonly q: string
  readonly a: string
  readonly facts_used: readonly string[]
}

export interface RecommendationInternalLinks {
  /** Other pages that should link **to** this one. */
  readonly add_from: readonly { readonly url: string; readonly anchor: string }[]
  /** Pages **this** page should link to. */
  readonly add_to: readonly { readonly url: string; readonly anchor: string }[]
}

/** The recommendation as it is stored and rendered — main §10.3 step 3. */
export interface OptimizeRecommendation {
  readonly title_tag: RecommendationField
  readonly meta_description: RecommendationField
  readonly headings: readonly RecommendationHeading[]
  readonly sections: readonly RecommendationSection[]
  readonly faq: readonly RecommendationFaq[]
  readonly internal_links: RecommendationInternalLinks
  readonly intent_note: string
}

const FIELD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['current', 'suggested', 'rationale'],
  properties: {
    current: { type: ['string', 'null'] },
    suggested: { type: 'string', minLength: 1 },
    rationale: { type: ['string', 'null'] },
  },
} as const

const LINK_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['url', 'anchor'],
    properties: { url: { type: 'string', minLength: 1 }, anchor: { type: 'string', minLength: 1 } },
  },
} as const

export const RECOMMENDATION_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title_tag', 'meta_description', 'headings', 'sections', 'faq', 'internal_links', 'intent_note'],
  properties: {
    title_tag: FIELD_SCHEMA,
    meta_description: FIELD_SCHEMA,
    headings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'level', 'text', 'after'],
        properties: {
          op: { type: 'string', enum: ['add', 'rewrite'] },
          level: { type: 'integer', minimum: 2, maximum: 4 },
          text: { type: 'string', minLength: 1 },
          after: { type: ['string', 'null'] },
        },
      },
    },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'suggested_copy', 'facts_used', 'gap_source'],
        properties: {
          heading: { type: 'string', minLength: 1 },
          suggested_copy: { type: 'string', minLength: 1 },
          facts_used: { type: 'array', items: { type: 'string', minLength: 1 } },
          gap_source: { type: 'string', enum: ['serp', 'store'] },
        },
      },
    },
    faq: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['q', 'a', 'facts_used'],
        properties: {
          q: { type: 'string', minLength: 1 },
          a: { type: 'string', minLength: 1 },
          facts_used: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
      },
    },
    internal_links: {
      type: 'object',
      additionalProperties: false,
      required: ['add_from', 'add_to'],
      properties: { add_from: LINK_SCHEMA, add_to: LINK_SCHEMA },
    },
    intent_note: { type: 'string', minLength: 1 },
  },
} as const

/**
 * What the page is *for* decides what a good edit to it looks like, so the page
 * type selects a paragraph of instruction rather than a different output shape.
 * A collection is a shortlist someone is choosing from; a product page is one
 * thing being decided on; an article is an explanation. The same suggestion
 * would be right on one and out of place on another.
 */
const PAGE_TYPE_BRIEF: Readonly<Record<StorePageType, string>> = {
  collection:
    'This is a collection: a list of products someone is choosing between. Good edits help them choose — what separates the products here, who each suits, what to check before buying. Do not turn it into an article; the products stay the point of the page.',
  product:
    'This is one product\'s page. Good edits answer what someone still needs to know before buying this specific thing: how it is used, what it fits, how it is cared for, what the stated claims mean. Never invent a specification.',
  page:
    'This is a standing page of the store — about, shipping, a guide. Good edits make it answer the search directly and completely, in the store\'s own voice.',
  blog_article:
    'This is an article the merchant wrote. Good edits add what the ranking pages settle and this does not, and tighten a title that undersells it. Keep the existing structure; do not propose a rewrite.',
  article_ours:
    'This is an article we published for this store. Suggest only additions and metadata changes here.',
  other:
    'The type of this page is not known. Stay close to what it already does, and prefer additions to rewrites.',
}

export interface RecommendationPrompt {
  readonly version: string
  readonly text: string
}

export interface BuildRecommendationInput {
  readonly prompt: RecommendationPrompt
  readonly pack: OptimizeEvidencePack
  readonly limits: { readonly titleMaxChars: number; readonly metaMaxChars: number }
  /**
   * The lint failures of the previous attempt, appended verbatim on the one
   * re-ask main §10.3 allows. Absent on a first attempt.
   */
  readonly lintErrors?: readonly string[]
}

function pageBlock(pack: OptimizeEvidencePack): string {
  const { page } = pack
  return [
    `Address: ${page.url}`,
    `Page title: ${page.title ?? '(none)'}`,
    `Search-result title: ${page.seoTitle ?? '(none set)'}`,
    `Search-result description: ${page.seoDescription ?? '(none set)'}`,
    `Headings: ${page.headings.join(' | ') || '(none)'}`,
    `Text: ${page.bodyText || '(empty)'}`,
  ].join('\n')
}

function searchBlock(pack: OptimizeEvidencePack): string {
  if (pack.queries.length === 0) return 'No Search Console data is held for this page.'
  return [
    `What this page is found for, over the last ${pack.queryWindowDays} days:`,
    ...pack.queries.map(
      (q) =>
        `- "${q.query}" — ${q.impressions} impressions, ${q.clicks} clicks, average position ${
          q.position === null ? 'unknown' : q.position.toFixed(1)
        }`,
    ),
  ].join('\n')
}

function gapBlock(pack: OptimizeEvidencePack): string {
  if (pack.missingSubtopics.length === 0) {
    return 'No comparison against the ranking pages was available, so propose only what the store\'s own facts support.'
  }
  return [
    'What the pages ranking for that search settle and this page does not:',
    ...pack.missingSubtopics.map((subtopic) => {
      const where = subtopic.competitors
        .map((c) => `${c.url}${c.heading ? ` (under "${c.heading}")` : ''}`)
        .join('; ')
      return `- ${subtopic.name} — cite as subtopic:${subtopic.name} — covered by ${where}`
    }),
  ].join('\n')
}

function factsBlock(pack: OptimizeEvidencePack): string {
  const facts = citableStoreFacts(pack)
  if (facts.length === 0) return 'The store has no recorded product facts for this page.'
  return [
    'The store\'s own facts. Cite each by the address in brackets, exactly as written:',
    ...facts.map((fact) => `- [${fact.address}] ${fact.label}: ${fact.value}`),
  ].join('\n')
}

function linksBlock(pack: OptimizeEvidencePack): string {
  if (pack.linkCandidates.length === 0) return 'No other pages of this store are available to link.'
  return [
    'Other pages of this store, for internal-link suggestions. Use these addresses exactly:',
    ...pack.linkCandidates.map((c) => `- ${c.url} (${c.pageType}) — ${c.title ?? '(untitled)'}`),
    `Already linked from this page: ${pack.page.outboundInternalLinks.join(', ') || '(nothing)'}`,
  ].join('\n')
}

function personaBlock(pack: OptimizeEvidencePack): string {
  if (!pack.persona) return 'No store profile is held; write plainly.'
  return [
    'How the store describes itself:',
    pack.persona.description,
    `Audience: ${pack.persona.audience}`,
    `Tone: ${pack.persona.tone}`,
    `Language: ${pack.persona.language}-${pack.persona.country}`,
  ].join('\n')
}

export function buildRecommendationRequest(input: BuildRecommendationInput): LlmRequest {
  const { pack } = input
  const content = [
    `The search: ${pack.targetQuery}`,
    `Page type: ${pack.page.pageType}. ${PAGE_TYPE_BRIEF[pack.page.pageType]}`,
    `Title limit: ${input.limits.titleMaxChars} characters. Description limit: ${input.limits.metaMaxChars} characters.`,
    '',
    '--- The page as it stands ---',
    pageBlock(pack),
    '',
    '--- What it earns in search ---',
    searchBlock(pack),
    '',
    '--- What the ranking pages cover ---',
    gapBlock(pack),
    '',
    '--- What the store knows ---',
    factsBlock(pack),
    '',
    '--- Where it could link ---',
    linksBlock(pack),
    '',
    '--- The store\'s voice ---',
    personaBlock(pack),
  ]

  if (input.lintErrors && input.lintErrors.length > 0) {
    content.push(
      '',
      '--- Your previous attempt failed these checks. Fix exactly these and change nothing else ---',
      ...input.lintErrors.map((error) => `- ${error}`),
    )
  }

  return {
    callType: 'optimize_reco',
    promptVersion: input.prompt.version,
    system: input.prompt.text,
    messages: [{ role: 'user', content: content.join('\n') }],
    maxTokens: 4000,
    schema: RECOMMENDATION_RESPONSE_SCHEMA,
    attribution: accountAttribution(pack.accountId),
  }
}

export interface GenerateRecommendationDeps {
  readonly llm: LlmClient
  readonly prompt: RecommendationPrompt
}

export interface GeneratedRecommendation {
  readonly recommendation: OptimizeRecommendation
  readonly modelId: string
  readonly promptVersion: string
  readonly cacheHit: boolean
  readonly usdCost: number
}

/** One attempt. The re-ask, the lints and the grading are the caller's business. */
export async function generateRecommendation(
  deps: GenerateRecommendationDeps,
  input: Omit<BuildRecommendationInput, 'prompt'>,
): Promise<GeneratedRecommendation> {
  const result = await deps.llm.complete<OptimizeRecommendation>(
    buildRecommendationRequest({ ...input, prompt: deps.prompt }),
  )
  return {
    recommendation: result.output,
    modelId: result.modelId,
    promptVersion: result.promptVersion,
    cacheHit: result.cacheHit,
    usdCost: result.usdCost,
  }
}
