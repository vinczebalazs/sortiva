import { EXTRACTED_FIELDS } from '../../distill/schema'
import { deterministicDerivedClaims, deterministicMerchantClaims, type ClaimPlan, type PlannedClaim } from '../../generation/claims'
import type { Draft } from '../../generation/draft'
import type { EvidencePack } from '../../generation/evidence-pack'
import { checkableKindsIn, numbersIn, type CheckableLexicon } from './checkable'
import { sentencesOf, type ProseSentence } from './prose'

/**
 * The check that makes the whole claim model hold: a sentence asserting
 * something checkable must say where it came from, and what it cites must
 * actually say what the sentence says.
 *
 * Three failures live here, in the order they matter:
 *
 * 1. **An uncited assertion.** The sentence carries a number, a measurement, a
 *    superlative, an absolute, an attribution or a comparison and has no
 *    citation marker at all. Forgetting to cite must be a failure, or it
 *    becomes the cheapest route to an unsupported claim.
 * 2. **A citation that does not resolve**, or a number in the sentence that
 *    appears in none of the claims it cites — the marker is there, but it is
 *    pointing at something else.
 * 3. **A claim that does not match its own evidence.** A merchant fact must
 *    restate a value that is really in the fact sheet; an external fact's
 *    quote must appear verbatim in the passage it names; and a claim that
 *    follows arithmetically is **re-derived here from the pack**, not taken on
 *    trust and not re-judged by a model — arithmetic has an answer.
 */

export type CitationIssueKind =
  | 'uncited_checkable_content'
  | 'unknown_claim_marker'
  | 'number_absent_from_cited_claims'
  | 'merchant_fact_not_in_fact_sheet'
  | 'external_quote_not_verbatim'
  | 'derived_claim_not_re_derivable'
  | 'recommendation_rests_on_nothing'

export interface CitationIssue {
  readonly kind: CitationIssueKind
  /** Where in the article, in words a merchant could act on. */
  readonly location: string
  readonly sentence: string
  readonly detail: string
}

export interface CitationCheckResult {
  readonly passed: boolean
  readonly issues: readonly CitationIssue[]
  readonly checkedSentenceCount: number
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Numbers are compared as numbers, so "20" and "20.0" and "20,0" are the same reading. */
function claimCarriesNumber(claim: PlannedClaim, pack: EvidencePack, target: number): boolean {
  if (numbersIn(claim.text).includes(target)) return true
  for (const ref of claim.evidence) {
    if (ref.kind !== 'product') continue
    const product = pack.products.find((p) => p.productId === ref.productId)
    const value = product?.factSheet[ref.field]
    const text = Array.isArray(value) ? value.join(' ') : (value ?? '')
    if (typeof text === 'string' && numbersIn(text).includes(target)) return true
  }
  return false
}

function factSheetValues(pack: EvidencePack, productId: string, field: string): string[] {
  const product = pack.products.find((p) => p.productId === productId)
  if (!product) return []
  if (!(EXTRACTED_FIELDS as readonly string[]).includes(field)) return []
  const value = product.factSheet[field as (typeof EXTRACTED_FIELDS)[number]]
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return typeof value === 'string' ? [value] : []
}

/**
 * The arithmetic claims recomputed from the evidence pack. A `derived_fact`
 * the writer cited has to be one of these, character for character: if the
 * plan carries a comparison the pack's own numbers do not produce, the
 * comparison is wrong and no amount of grading would notice.
 */
function reDerivedClaimTexts(pack: EvidencePack): Set<string> {
  const merchant = deterministicMerchantClaims(pack)
  const derived = deterministicDerivedClaims(pack, merchant, merchant.length)
  return new Set(derived.map((c) => normalise(c.text)))
}

function checkClaimAgainstEvidence(
  claim: PlannedClaim,
  plan: ClaimPlan,
  pack: EvidencePack,
  reDerived: Set<string>,
  sentence: ProseSentence,
): CitationIssue[] {
  const issues: CitationIssue[] = []
  const base = { location: sentence.block.label, sentence: sentence.plain }

  if (claim.kind === 'merchant_fact') {
    for (const ref of claim.evidence) {
      if (ref.kind !== 'product') continue
      const values = factSheetValues(pack, ref.productId, ref.field)
      const claimText = normalise(claim.text)
      if (!values.some((value) => claimText.includes(normalise(value)))) {
        issues.push({
          ...base,
          kind: 'merchant_fact_not_in_fact_sheet',
          detail: `claim ${claim.id} says "${claim.text}" but product ${ref.productId}'s ${ref.field} does not read that way`,
        })
      }
    }
  }

  if (claim.kind === 'external_fact') {
    for (const ref of claim.evidence) {
      if (ref.kind !== 'page') continue
      const angle = pack.serp.competitorAngles.find((a) => a.url === ref.url)
      if (!angle || !angle.excerpt.includes(ref.quote)) {
        issues.push({
          ...base,
          kind: 'external_quote_not_verbatim',
          detail: `claim ${claim.id} quotes ${ref.url}, but those exact words are not in the passage we hold`,
        })
      }
    }
  }

  if (claim.kind === 'derived_fact' && !reDerived.has(normalise(claim.text))) {
    issues.push({
      ...base,
      kind: 'derived_claim_not_re_derivable',
      detail: `claim ${claim.id} says "${claim.text}", which the pack's own figures do not produce when the comparison is worked out again`,
    })
  }

  if (claim.kind === 'recommendation') {
    const restsOn = claim.evidence.filter((ref) => ref.kind === 'claim')
    const known = new Set(plan.claims.map((c) => c.id))
    if (restsOn.length === 0 || !restsOn.every((ref) => ref.kind === 'claim' && known.has(ref.claimRef))) {
      issues.push({
        ...base,
        kind: 'recommendation_rests_on_nothing',
        detail: `claim ${claim.id} is advice that names no established fact behind it`,
      })
    }
  }

  return issues
}

export function checkCitations(
  draft: Draft,
  plan: ClaimPlan,
  pack: EvidencePack,
  lexicon: CheckableLexicon | null,
): CitationCheckResult {
  const byId = new Map(plan.claims.map((c) => [c.id, c]))
  const reDerived = reDerivedClaimTexts(pack)
  const issues: CitationIssue[] = []
  const sentences = sentencesOf(draft)

  for (const sentence of sentences) {
    const base = { location: sentence.block.label, sentence: sentence.plain }
    const kinds = checkableKindsIn(sentence.plain, lexicon)

    if (kinds.length > 0 && sentence.citedClaimIds.length === 0) {
      issues.push({
        ...base,
        kind: 'uncited_checkable_content',
        detail: `states something checkable (${kinds.join(', ')}) and cites nothing`,
      })
      continue
    }

    const cited: PlannedClaim[] = []
    for (const id of sentence.citedClaimIds) {
      const claim = byId.get(id)
      if (!claim) {
        issues.push({ ...base, kind: 'unknown_claim_marker', detail: `[[${id}]] cites no claim in the approved plan` })
        continue
      }
      cited.push(claim)
    }
    if (cited.length === 0) continue

    for (const value of numbersIn(sentence.plain)) {
      if (!cited.some((claim) => claimCarriesNumber(claim, pack, value))) {
        issues.push({
          ...base,
          kind: 'number_absent_from_cited_claims',
          detail: `the figure ${value} appears in none of the claims this sentence cites (${sentence.citedClaimIds.join(', ')})`,
        })
      }
    }

    for (const claim of cited) {
      issues.push(...checkClaimAgainstEvidence(claim, plan, pack, reDerived, sentence))
    }
  }

  return { passed: issues.length === 0, issues, checkedSentenceCount: sentences.length }
}
