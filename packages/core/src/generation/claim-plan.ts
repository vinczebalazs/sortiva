import { accountAttribution } from '../contracts/analytics'
import { CONFIDENCE_BANDS } from '../contracts/opportunities'
import type { LlmClient, LlmRequest } from '../contracts/llm'
import {
  deterministicDerivedClaims,
  deterministicMerchantClaims,
  type ClaimGap,
  type ClaimPlan,
  type PlannedClaim,
} from './claims'
import type { EvidencePack } from './evidence-pack'

/**
 * Builds the claim plan: the deterministic merchant/derived claims
 * (`claims.ts`, no model call), plus a `claim_plan` model call for the two
 * kinds that need judgement — a recommendation, or an external fact quoted
 * from a competitor page. This is what runs between evidence assembly and
 * drafting, and its output — never the pack — is what `draft.ts` shows the
 * writer. `docs/content-pointers.md` §1.
 */

export interface ClaimPlanPrompt {
  readonly version: string
  readonly text: string
}

export interface PlanClaimsDeps {
  readonly llm: LlmClient
  readonly prompt: ClaimPlanPrompt
}

export interface PlanClaimsResult {
  readonly plan: ClaimPlan
  readonly modelId: string
  readonly promptVersion: string
}

const MODEL_CLAIM_KINDS = ['external_fact', 'recommendation'] as const

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claims', 'gaps'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'kind', 'confidence', 'evidenceRefs', 'quote'],
        properties: {
          text: { type: 'string', minLength: 1 },
          kind: { type: 'string', enum: [...MODEL_CLAIM_KINDS] },
          confidence: { type: 'string', enum: [...CONFIDENCE_BANDS] },
          /** For a recommendation: the deterministic claim ids it rests on. Empty for an external fact. */
          evidenceRefs: { type: 'array', items: { type: 'string' } },
          /** For an external fact: the verbatim quote and which page it came from. Null for a recommendation. */
          quote: {
            type: ['object', 'null'],
            additionalProperties: false,
            required: ['text', 'url'],
            properties: {
              text: { type: 'string', minLength: 1 },
              url: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'reason'],
        properties: {
          text: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const

interface ModelClaim {
  readonly text: string
  readonly kind: (typeof MODEL_CLAIM_KINDS)[number]
  readonly confidence: (typeof CONFIDENCE_BANDS)[number]
  readonly evidenceRefs: readonly string[]
  readonly quote: { readonly text: string; readonly url: string } | null
}

interface ClaimPlanOutput {
  readonly claims: readonly ModelClaim[]
  readonly gaps: readonly ClaimGap[]
}

function factsBlock(claims: readonly PlannedClaim[]): string {
  if (claims.length === 0) return '(none)'
  return claims.map((c) => `${c.id} [${c.kind}]: ${c.text}`).join('\n')
}

function competitorBlock(pack: EvidencePack): string {
  if (pack.serp.competitorAngles.length === 0) return '(no competitor pages fetched)'
  return pack.serp.competitorAngles
    .map(
      (angle) =>
        `${angle.url} (${angle.domain}, position ${angle.position})\nHeadings: ${angle.headings.join(' | ') || '(none)'}\nExcerpt: ${angle.excerpt}`,
    )
    .join('\n\n')
}

export function buildClaimPlanRequest(input: {
  readonly prompt: ClaimPlanPrompt
  readonly pack: EvidencePack
  readonly deterministicClaims: readonly PlannedClaim[]
}): LlmRequest {
  const axesBlock = input.pack.families.map((f) => `${f.name}: ${f.differentiationAxes.join(', ') || '(none)'}`).join('\n')

  return {
    callType: 'claim_plan',
    promptVersion: input.prompt.version,
    system: input.prompt.text,
    messages: [
      {
        role: 'user',
        content: [
          `Target keyword: ${input.pack.targetKeyword}`,
          `Intent class: ${input.pack.intentClass}`,
          '',
          'Product families and their differentiation axes:',
          axesBlock || '(none)',
          '',
          'Already-established facts (cite these ids in evidenceRefs for a recommendation):',
          factsBlock(input.deterministicClaims),
          '',
          'Competitor pages (quote verbatim for an external fact):',
          competitorBlock(input.pack),
        ].join('\n'),
      },
    ],
    maxTokens: 2000,
    schema: RESPONSE_SCHEMA,
    attribution: accountAttribution(input.pack.accountId),
  }
}

/** True only when `quote` appears, character-for-character after trimming, inside `excerpt`. No fuzzy matching — a paraphrase is not a citation. */
function quoteIsVerbatim(quote: string, excerpt: string): boolean {
  return excerpt.includes(quote.trim())
}

export async function planClaims(deps: PlanClaimsDeps, pack: EvidencePack): Promise<PlanClaimsResult> {
  const merchantClaims = deterministicMerchantClaims(pack)
  const derivedClaims = deterministicDerivedClaims(pack, merchantClaims, merchantClaims.length)
  const deterministicClaims = [...merchantClaims, ...derivedClaims]

  const result = await deps.llm.complete<ClaimPlanOutput>(
    buildClaimPlanRequest({ prompt: deps.prompt, pack, deterministicClaims }),
  )

  const gaps: ClaimGap[] = [...result.output.gaps]
  const accepted: PlannedClaim[] = []
  let n = deterministicClaims.length

  const knownIds = new Set(deterministicClaims.map((c) => c.id))
  const excerptsByUrl = new Map(pack.serp.competitorAngles.map((a) => [a.url, a.excerpt]))

  for (const candidate of result.output.claims) {
    if (candidate.kind === 'external_fact') {
      const excerpt = candidate.quote ? excerptsByUrl.get(candidate.quote.url) : undefined
      if (!candidate.quote || !excerpt || !quoteIsVerbatim(candidate.quote.text, excerpt)) {
        gaps.push({
          text: candidate.text,
          reason: 'external fact dropped: quote did not match a fetched competitor page verbatim',
        })
        continue
      }
      n += 1
      accepted.push({
        id: `c${n}`,
        text: candidate.text,
        kind: 'external_fact',
        confidence: candidate.confidence,
        evidence: [{ kind: 'page', url: candidate.quote.url, quote: candidate.quote.text }],
      })
      continue
    }

    // recommendation
    const refs = candidate.evidenceRefs.filter((ref) => knownIds.has(ref) || accepted.some((c) => c.id === ref))
    if (refs.length === 0) {
      gaps.push({
        text: candidate.text,
        reason: 'recommendation dropped: named no claim it rests on',
      })
      continue
    }
    n += 1
    accepted.push({
      id: `c${n}`,
      text: candidate.text,
      kind: 'recommendation',
      confidence: candidate.confidence,
      evidence: refs.map((claimRef) => ({ kind: 'claim' as const, claimRef })),
    })
  }

  return {
    plan: { claims: [...deterministicClaims, ...accepted], gaps },
    modelId: result.modelId,
    promptVersion: result.promptVersion,
  }
}
