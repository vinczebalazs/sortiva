import { accountAttribution } from '../contracts/analytics'
import type { LlmClient, LlmRequest } from '../contracts/llm'
import type { PlannedClaim } from './claims'
import type { InternalLinkTarget } from './internal-links'
import type { LengthTarget } from './length'
import { PRODUCT_REF_FIELDS, PRODUCT_REF_TYPES, type ProductRefField, type ProductRefType } from './product-refs'
import { type ArticleShape, sectionsFor, skeletonFor } from './shapes'

/**
 * The writer — Sonnet, `call_type: draft` — shown only the approved claim
 * list (`ClaimPlan.claims`, text/kind/confidence only — never a claim's
 * evidence, and never the pack it came from) plus the section skeleton, the
 * length target and the internal links it must carry. This is the structural
 * half of `docs/content-pointers.md` §1's guarantee: there is no field on
 * this request that could hand the writer a fact its claim plan did not
 * already approve.
 */

export interface DraftPrompt {
  readonly version: string
  readonly text: string
}

export interface CitableProduct {
  /** Local id, e.g. `p1` — what a `{{p1}}` token in the draft resolves to. */
  readonly id: string
  readonly productId: string
  /** Name only — no description, no fact sheet. Enough to say which product a recommendation names. */
  readonly title: string
}

export interface BuildDraftRequestInput {
  readonly prompt: DraftPrompt
  readonly accountId: string
  readonly targetKeyword: string
  readonly shape: ArticleShape
  readonly axes: readonly string[]
  readonly claims: readonly PlannedClaim[]
  readonly citableProducts: readonly CitableProduct[]
  readonly length: LengthTarget
  readonly internalLinks: readonly InternalLinkTarget[]
}

export interface DraftSection {
  readonly heading: string
  readonly body: string
}

export interface DraftFaqEntry {
  readonly question: string
  readonly answer: string
}

export interface DraftProductMentionOutput {
  readonly id: string
  readonly productId: string
  readonly refType: ProductRefType
  readonly fields: readonly ProductRefField[]
}

export interface Draft {
  readonly title: string
  readonly metaDescription: string
  readonly intro: string
  readonly sections: readonly DraftSection[]
  readonly faq: readonly DraftFaqEntry[]
  readonly productMentions: readonly DraftProductMentionOutput[]
}

/**
 * The draft as `articles.body_json` stores it.
 *
 * Three of the writer's fields are deliberately absent. `title` and
 * `metaDescription` have columns of their own, and **the column is the
 * authoritative copy** — the calendar, the articles list, publishing and
 * export all read the row, so a second copy inside the JSON would be two
 * answers to one question, drifting apart the first time one of them is
 * corrected. `productMentions` is absent for the same reason:
 * `article_product_refs` already holds those as rows. See DECISIONS
 * 2026-09-03 T4.4.
 */
export interface ArticleBody {
  readonly intro: string
  readonly sections: readonly DraftSection[]
  readonly faq: readonly DraftFaqEntry[]
}

export function articleBodyOf(draft: Draft): ArticleBody {
  return { intro: draft.intro, sections: draft.sections, faq: draft.faq }
}

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'metaDescription', 'intro', 'sections', 'faq', 'productMentions'],
  properties: {
    title: { type: 'string', minLength: 1 },
    metaDescription: { type: 'string', minLength: 1 },
    intro: { type: 'string', minLength: 1 },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'body'],
        properties: { heading: { type: 'string', minLength: 1 }, body: { type: 'string', minLength: 1 } },
      },
    },
    faq: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'answer'],
        properties: { question: { type: 'string', minLength: 1 }, answer: { type: 'string', minLength: 1 } },
      },
    },
    productMentions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'productId', 'refType', 'fields'],
        properties: {
          id: { type: 'string', minLength: 1 },
          productId: { type: 'string', minLength: 1 },
          refType: { type: 'string', enum: [...PRODUCT_REF_TYPES] },
          fields: { type: 'array', items: { type: 'string', enum: [...PRODUCT_REF_FIELDS] }, minItems: 1 },
        },
      },
    },
  },
} as const

function claimsBlock(claims: readonly PlannedClaim[]): string {
  if (claims.length === 0) return '(no approved claims)'
  return claims.map((c) => `${c.id} [${c.kind}, ${c.confidence} confidence]: ${c.text}`).join('\n')
}

function productsBlock(products: readonly CitableProduct[]): string {
  if (products.length === 0) return '(no products to mention)'
  return products.map((p) => `${p.id}: ${p.title}`).join('\n')
}

export function buildDraftRequest(input: BuildDraftRequestInput): LlmRequest {
  const skeleton = skeletonFor(input.shape)
  const sections = sectionsFor(input.shape, input.axes)

  return {
    callType: 'draft',
    promptVersion: input.prompt.version,
    system: input.prompt.text,
    messages: [
      {
        role: 'user',
        content: [
          `Target keyword: ${input.targetKeyword}`,
          `Shape: ${input.shape} (fails when: ${skeleton.failureCondition})`,
          `Section order: ${sections.join(' / ')}`,
          `Target length: ${input.length.minWords}-${input.length.maxWords} words total.`,
          `Must link to: ${input.internalLinks.map((l) => l.url).join(', ') || '(nothing required)'}`,
          '',
          'Approved claims — cite each one you use with its id in the form [[id]] immediately after the sentence. Do not state anything not covered by one of these:',
          claimsBlock(input.claims),
          '',
          'Products you may mention or recommend — name a product with its id from this list, in the form {{id}}, and declare it in productMentions with the fields you rendered it with (e.g. price, url):',
          productsBlock(input.citableProducts),
        ].join('\n'),
      },
    ],
    maxTokens: 4000,
    schema: RESPONSE_SCHEMA,
    attribution: accountAttribution(input.accountId),
  }
}

export interface WriteDraftDeps {
  readonly llm: LlmClient
}

export interface WriteDraftResult {
  readonly draft: Draft
  readonly modelId: string
  readonly promptVersion: string
}

export async function writeDraft(deps: WriteDraftDeps, input: BuildDraftRequestInput): Promise<WriteDraftResult> {
  const result = await deps.llm.complete<Draft>(buildDraftRequest(input))
  return { draft: result.output, modelId: result.modelId, promptVersion: result.promptVersion }
}
