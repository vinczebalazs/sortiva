import { emptyFactSheet } from '../../distill/schema'
import { deterministicMerchantClaims, type ClaimPlan } from '../../generation/claims'
import type { Draft } from '../../generation/draft'
import { assembleEvidencePack, type EvidencePack, type EvidencePackProduct } from '../../generation/evidence-pack'

/**
 * Fixtures shared by this directory's tests. Test-only — not exported from
 * `gate3/index.ts`, and nothing in production reaches them.
 *
 * The pack is a real one: three backpacks in one family with real materials,
 * capacities and weights, so the claim plan below is derived by the same
 * function the pipeline uses rather than written by hand. A hand-written claim
 * plan would let a test pass against claims the real derivation never
 * produces.
 */

export function packProduct(
  id: string,
  title: string,
  overrides: Partial<EvidencePackProduct['factSheet']> = {},
): EvidencePackProduct {
  return { productId: id, familyId: 'f1', title, images: [], factSheet: { ...emptyFactSheet(), ...overrides } }
}

export function fixturePack(): EvidencePack {
  return assembleEvidencePack({
    accountId: 'a1',
    topicId: 't1',
    intentClass: 'buying_guide',
    targetKeyword: 'hiking backpacks',
    families: [{ familyId: 'f1', name: 'Backpacks', differentiationAxes: ['capacity'] }],
    products: [
      packProduct('p-alpha', 'The Alpha', { material: 'ripstop nylon', capacity: '20 litres', origin: 'Portugal' }),
      packProduct('p-beta', 'The Beta', { material: 'waxed canvas', capacity: '35 litres', origin: 'Vietnam' }),
      packProduct('p-gamma', 'The Gamma', { material: 'recycled polyester', capacity: '28 litres', origin: 'Vietnam' }),
    ],
    serp: {
      keyword: 'hiking backpacks',
      locale: 'en-US',
      topResultCount: 3,
      averageWordCount: 400,
      competitorAngles: [
        {
          url: 'https://rival.example/packs',
          domain: 'rival.example',
          position: 1,
          headings: ['How to choose', 'Our picks'],
          excerpt: 'Fit matters more than volume for most walkers.',
        },
      ],
    },
    linkTasks: [],
    now: new Date('2026-09-03T07:00:00.000Z'),
  })
}

/** The plan the pipeline would really build from `fixturePack()`, plus one recommendation. */
export function fixturePlan(pack: EvidencePack): ClaimPlan {
  const merchant = deterministicMerchantClaims(pack)
  return {
    claims: [
      ...merchant,
      {
        id: 'r1',
        text: 'For a weekend away, the 35-litre pack is usually the one to take.',
        kind: 'recommendation',
        confidence: 'medium',
        evidence: [{ kind: 'claim', claimRef: merchant[0]!.id }],
      },
    ],
    gaps: [],
  }
}

/** Which claim id carries a given product's field, so a fixture draft can cite it correctly. */
export function claimIdFor(plan: ClaimPlan, productId: string, field: string): string {
  const claim = plan.claims.find((c) =>
    c.evidence.some((e) => e.kind === 'product' && e.productId === productId && e.field === field),
  )
  if (!claim) throw new Error(`no claim for ${productId}.${field}`)
  return claim.id
}

/**
 * A draft that passes every free check: long enough for the length floor,
 * every checkable sentence cited, no repeated target phrase, no figure stated
 * two different ways.
 */
export function passingDraft(plan: ClaimPlan): Draft {
  const alphaMaterial = claimIdFor(plan, 'p-alpha', 'material')
  const alphaCapacity = claimIdFor(plan, 'p-alpha', 'capacity')
  const betaCapacity = claimIdFor(plan, 'p-beta', 'capacity')

  return {
    title: 'Choosing a hiking pack',
    metaDescription: 'Which pack size suits which kind of walk, and what the fabric changes.',
    intro:
      'For a day on a marked trail, a compact pack is enough, and walkers who buy bigger tend to end up carrying air. ' +
      'The Alpha holds 20 litres, which covers water, a layer and lunch with room to spare[[' +
      alphaCapacity +
      ']]. Go larger only once you are carrying something overnight.',
    sections: [
      {
        heading: 'What the fabric changes',
        body:
          'The Alpha is made of ripstop nylon, which is the lighter of the two shell fabrics here and shrugs off a shower without a cover[[' +
          alphaMaterial +
          ']]. Waxed canvas is heavier and wears in rather than out, which is why it turns up on packs meant to be carried every day rather than once a season. ' +
          'Neither choice is wrong; they simply fail differently, and knowing which failure you mind is most of the decision.',
      },
      {
        heading: 'Selection criteria: by capacity',
        body:
          'The Beta holds 35 litres, which is where a pack stops being a daysack and starts being luggage[[' +
          betaCapacity +
          ']]. For a weekend away, that is usually the one to take[[r1]]. ' +
          'Anything past that and you are into expedition territory, where fit and frame carry the decision and the shopping problem changes shape entirely.',
      },
      {
        heading: 'Common mistakes',
        body:
          'The usual one is buying for the biggest trip you might one day take rather than the trip you take most weeks. ' +
          'The second is ignoring how a loaded pack sits: a well-fitted small one will carry comfortably where a badly-fitted large one digs in, and no amount of padding fixes a back length that is wrong for you.',
      },
    ],
    faq: [],
    productMentions: [],
  }
}
