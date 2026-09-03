import type { GatesConfig } from '@sortiva/rules'
import { deterministicMerchantClaims } from './claims'
import type { EvidencePack } from './evidence-pack'

/**
 * Gate 2 — the evidence pack check, main §8.3: after research, before
 * drafting, a cheap check verifies the pack contains enough distinct,
 * non-generic claims. "A 90%-boilerplate pack is killed here."
 *
 * Runs on the pack directly, before the claim-plan model call — it exists
 * specifically to avoid paying for that call (and the writer call after it)
 * on a pack with nothing to say. It reuses the same deterministic
 * merchant-fact derivation `claims.ts` uses for the real plan, so a pack that
 * passes here is counted the same way the plan that follows will count it.
 */

export interface Gate2BoilerplateEntry {
  readonly familyId: string
  readonly field: string
  readonly value: string
  /** Share of the family's contributing products stating this exact value. */
  readonly repeatShare: number
}

export interface Gate2Result {
  readonly outcome: 'admitted' | 'held_thin_pack'
  readonly distinctClaimCount: number
  readonly boilerplateClaimCount: number
  readonly boilerplateRatio: number
  readonly boilerplateEntries: readonly Gate2BoilerplateEntry[]
  readonly reasonTemplateKey: string | null
  readonly reasonParams: Readonly<Record<string, string | number>>
}

interface BoilerplateGroup {
  readonly familyId: string
  readonly field: string
  readonly value: string
  readonly productIds: Set<string>
}

export function runGate2(pack: EvidencePack, config: GatesConfig['evidence_pack_check']): Gate2Result {
  const merchantClaims = deterministicMerchantClaims(pack)

  // A claim's text is its distinctness identity: two products stating the
  // same fact in the same words are one claim, not two (matching
  // `distinctFactsOf` in `signals/substance.ts`). Competitor-angle headings
  // count too — main §8.3 counts "competitor angles" among a pack's claims.
  const distinctTexts = new Set<string>(merchantClaims.map((c) => c.text))
  for (const angle of pack.serp.competitorAngles) {
    for (const heading of angle.headings) distinctTexts.add(`angle:${heading.trim().toLowerCase()}`)
  }
  const distinctClaimCount = distinctTexts.size

  // Boilerplate: a family/field/value repeated across most of that family's
  // contributing products reads as generic rather than specific to any one
  // of them (main §8.3's "90%-boilerplate"). Grouped by the triple itself,
  // not a joined string key — a fact-sheet value like "20 litres" carries a
  // space of its own, which a space-joined key would misparse on split.
  const familyProductCounts = new Map<string, number>()
  for (const product of pack.products) {
    familyProductCounts.set(product.familyId, (familyProductCounts.get(product.familyId) ?? 0) + 1)
  }

  const groups = new Map<string, BoilerplateGroup>()
  for (const claim of merchantClaims) {
    const ref = claim.evidence[0]
    if (ref?.kind !== 'product') continue
    const product = pack.products.find((p) => p.productId === ref.productId)
    if (!product) continue
    const value = product.factSheet[ref.field]
    const scalarValue = Array.isArray(value) ? undefined : value
    if (typeof scalarValue !== 'string') continue

    const normalisedValue = scalarValue.trim().toLowerCase()
    const groupKey = JSON.stringify([product.familyId, ref.field, normalisedValue])
    const group: BoilerplateGroup =
      groups.get(groupKey) ??
      { familyId: product.familyId, field: ref.field, value: normalisedValue, productIds: new Set<string>() }
    group.productIds.add(product.productId)
    groups.set(groupKey, group)
  }

  const boilerplateEntries: Gate2BoilerplateEntry[] = []
  let boilerplateClaimCount = 0
  for (const group of groups.values()) {
    const total = familyProductCounts.get(group.familyId) ?? 0
    if (total === 0) continue
    const repeatShare = group.productIds.size / total
    if (repeatShare >= config.boilerplate_repeat_share_min) {
      boilerplateEntries.push({
        familyId: group.familyId,
        field: group.field,
        value: group.value,
        repeatShare,
      })
      boilerplateClaimCount += group.productIds.size
    }
  }

  const totalClaimCount = merchantClaims.length
  const boilerplateRatio = totalClaimCount === 0 ? 1 : boilerplateClaimCount / totalClaimCount

  const passes =
    distinctClaimCount >= config.distinct_claims_min && boilerplateRatio < config.boilerplate_ratio_max

  if (passes) {
    return {
      outcome: 'admitted',
      distinctClaimCount,
      boilerplateClaimCount,
      boilerplateRatio,
      boilerplateEntries,
      reasonTemplateKey: null,
      reasonParams: {},
    }
  }

  return {
    outcome: 'held_thin_pack',
    distinctClaimCount,
    boilerplateClaimCount,
    boilerplateRatio,
    boilerplateEntries,
    reasonTemplateKey: 'gate2.held_thin_pack',
    reasonParams: {
      distinct_claims: distinctClaimCount,
      distinct_claims_min: config.distinct_claims_min,
      boilerplate_ratio: Math.round(boilerplateRatio * 100) / 100,
      boilerplate_ratio_max: config.boilerplate_ratio_max,
    },
  }
}
