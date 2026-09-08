// Both reused, not redeclared, to avoid a name collision under
// `packages/core`'s barrel: `ConfidenceBand` already covers low/medium/high
// in the Opportunity Engine's own contracts, matching `packages/db`'s
// `confidence_band` enum; `ProductField` is `signals/substance.ts`'s existing
// name for a fact sheet's ten extractable fields, which is exactly what this
// module's claims are about.
import type { ConfidenceBand } from '../contracts/opportunities'
import type { ProductField } from '../signals/substance'
import { citableProductFacts, type EvidencePack, type EvidencePackProduct } from './evidence-pack'

/**
 * The claim plan — main idea of `docs/content-pointers.md` §1: every
 * assertion the article will make, enumerated against the evidence pack and
 * bound to it, before any prose is written. The writer (`draft.ts`) is shown
 * only the approved claims below, never the pack itself.
 */

export const CLAIM_KINDS = ['merchant_fact', 'external_fact', 'derived_fact', 'recommendation'] as const
export type ClaimKind = (typeof CLAIM_KINDS)[number]

export type { ConfidenceBand }

/**
 * Where a claim's support comes from. `content-pointers.md` §1: "which
 * product, which page, which quoted passage" for a merchant/external fact;
 * "must name the claims it rests on" for a derived fact or recommendation.
 */
export type ClaimEvidenceRef =
  | { readonly kind: 'product'; readonly productId: string; readonly field: ProductField }
  | { readonly kind: 'page'; readonly url: string; readonly quote: string }
  | { readonly kind: 'claim'; readonly claimRef: string }

export interface PlannedClaim {
  /** Local to this plan — `c1`, `c2`, ... — what the writer's citation markers reference. */
  readonly id: string
  readonly text: string
  readonly kind: ClaimKind
  readonly confidence: ConfidenceBand
  readonly evidence: readonly ClaimEvidenceRef[]
}

/** A claim considered and dropped, recorded rather than softened — `content-pointers.md` §1. */
export interface ClaimGap {
  readonly text: string
  readonly reason: string
}

export interface ClaimPlan {
  readonly claims: readonly PlannedClaim[]
  readonly gaps: readonly ClaimGap[]
}

/** Human-readable label for a fact-sheet field, used in claim text and derived comparisons. */
const FIELD_LABELS: Readonly<Record<ProductField, string>> = {
  material: 'material',
  dimensions: 'dimensions',
  weight: 'weight',
  capacity: 'capacity',
  compatibility: 'compatibility',
  use_cases_stated: 'use case',
  care: 'care',
  certifications: 'certification',
  origin: 'origin',
  verifiable_claims: 'claim',
}

function scalarClaimText(title: string, field: ProductField, value: string): string {
  if (field === 'material') return `${title} is made of ${value}.`
  if (field === 'dimensions') return `${title}'s dimensions are ${value}.`
  if (field === 'weight') return `${title} weighs ${value}.`
  if (field === 'capacity') return `${title} has a capacity of ${value}.`
  if (field === 'care') return `${title}'s care instructions: ${value}.`
  if (field === 'origin') return `${title} is made in ${value}.`
  return `${title}: ${FIELD_LABELS[field]} — ${value}.`
}

function listClaimText(title: string, field: ProductField, value: string): string {
  if (field === 'compatibility') return `${title} is compatible with ${value}.`
  if (field === 'use_cases_stated') return `${title} is described for ${value}.`
  if (field === 'certifications') return `${title} carries the ${value} certification.`
  if (field === 'verifiable_claims') return `${title}: ${value}`
  return `${title}: ${FIELD_LABELS[field]} — ${value}.`
}

/**
 * One merchant-fact claim per populated field per product — "something about
 * this store's own catalogue", `content-pointers.md` §1. High confidence: it
 * is a stored fact-sheet value, not an inference.
 *
 * The facts themselves come from `citableProductFacts`, which is also what the
 * judge's store-facts block is built from. Reading one list is what stops the
 * judge from holding evidence the writer never had.
 */
export function deterministicMerchantClaims(pack: EvidencePack): PlannedClaim[] {
  return citableProductFacts(pack).map((fact, index) => ({
    id: `c${index + 1}`,
    text: fact.fromList
      ? listClaimText(fact.productTitle, fact.field, fact.value)
      : scalarClaimText(fact.productTitle, fact.field, fact.value),
    kind: 'merchant_fact',
    confidence: 'high',
    evidence: [{ kind: 'product', productId: fact.productId, field: fact.field }],
  }))
}

/** The leading number and its trailing unit out of a short fact-sheet string, e.g. "20 litres" -> {value: 20, unit: "litres"}. */
function parseLeadingNumber(value: string): { readonly value: number; readonly unit: string } | null {
  const match = /^\s*([\d]+(?:[.,]\d+)?)\s*([a-zA-Zµ%]+)?/.exec(value)
  if (!match) return null
  const num = Number(match[1]!.replace(',', '.'))
  if (!Number.isFinite(num)) return null
  return { value: num, unit: (match[2] ?? '').toLowerCase() }
}

const NUMERIC_FIELDS: readonly ProductField[] = ['capacity', 'weight', 'dimensions']

/**
 * One arithmetic comparison per numeric field per family — "Model B holds
 * more than Model A" is arithmetic, re-derived here rather than asked of a
 * model (`content-pointers.md` §1). Bounded to the single widest spread per
 * field per family, so a ten-member family does not produce forty-five pairs
 * of the same observation.
 *
 * `merchantClaims` must be the plan's own merchant-fact claims (matching ids
 * by `productId`/`field`), so each derived claim can name the claims it rests
 * on rather than re-stating the product data itself.
 */
export function deterministicDerivedClaims(
  pack: EvidencePack,
  merchantClaims: readonly PlannedClaim[],
  startAt: number,
): PlannedClaim[] {
  const claims: PlannedClaim[] = []
  let n = startAt

  const claimFor = (productId: string, field: ProductField): PlannedClaim | undefined =>
    merchantClaims.find((c) =>
      c.evidence.some((e) => e.kind === 'product' && e.productId === productId && e.field === field),
    )

  for (const family of pack.families) {
    const members = pack.products.filter((p) => p.familyId === family.familyId)
    for (const field of NUMERIC_FIELDS) {
      const parsed = members
        .map((product) => {
          const raw = product.factSheet[field]
          const value = typeof raw === 'string' ? parseLeadingNumber(raw) : null
          return value ? { product, ...value } : null
        })
        .filter((entry): entry is { product: EvidencePackProduct; value: number; unit: string } => entry !== null)

      // Only compare like units — "20 litres" against "1.2 kg" is not a comparison.
      const byUnit = new Map<string, typeof parsed>()
      for (const entry of parsed) {
        const bucket = byUnit.get(entry.unit) ?? []
        bucket.push(entry)
        byUnit.set(entry.unit, bucket)
      }

      for (const [unit, entries] of byUnit) {
        if (entries.length < 2) continue
        const sorted = [...entries].sort((a, b) => a.value - b.value)
        const min = sorted[0]!
        const max = sorted[sorted.length - 1]!
        if (min.value === max.value) continue

        const minClaim = claimFor(min.product.productId, field)
        const maxClaim = claimFor(max.product.productId, field)
        if (!minClaim || !maxClaim) continue

        n += 1
        claims.push({
          id: `c${n}`,
          text: `${max.product.title} has more ${FIELD_LABELS[field]} than ${min.product.title} (${max.value}${unit} vs ${min.value}${unit}).`,
          kind: 'derived_fact',
          confidence: 'high',
          evidence: [
            { kind: 'claim', claimRef: maxClaim.id },
            { kind: 'claim', claimRef: minClaim.id },
          ],
        })
      }
    }
  }

  return claims
}
