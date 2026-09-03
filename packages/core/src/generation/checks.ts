import type { ClaimPlan } from './claims'
import type { CitableProduct, Draft } from './draft'
import { placeholdersIn } from './product-refs'
import { type ArticleShape, skeletonFor } from './shapes'

/**
 * The grounding harness — this card's own done-when: "every product claim in
 * a fixture draft maps to a pack fact." Since every `merchant_fact` /
 * `derived_fact` claim in the plan already **is** a pack fact by
 * construction (`claims.ts` derives them from `EvidencePackProduct.factSheet`
 * directly, with no model step in between), grounding a draft reduces to
 * referential integrity: every citation marker the writer used must resolve
 * to a real claim in the approved plan, and every product-mention token must
 * resolve to a product the writer was actually given. A marker that resolves
 * to nothing is exactly the fabrication route `docs/content-pointers.md` §1
 * says this design closes off, so it is reported as a hard issue, not a
 * warning.
 */

export interface GroundingIssue {
  readonly kind: 'unknown_claim_marker' | 'unknown_product_mention' | 'undeclared_product_mention'
  readonly detail: string
}

export interface GroundingResult {
  readonly grounded: boolean
  readonly issues: readonly GroundingIssue[]
  readonly citedClaimIds: readonly string[]
}

const CLAIM_MARKER = /\[\[\s*([a-zA-Z0-9_]+)\s*\]\]/g

function claimMarkersIn(text: string): string[] {
  return [...text.matchAll(CLAIM_MARKER)].map((m) => m[1]!)
}

function allProse(draft: Draft): string[] {
  return [draft.intro, ...draft.sections.map((s) => s.body), ...draft.faq.map((f) => f.answer)]
}

export function checkGrounding(
  draft: Draft,
  plan: ClaimPlan,
  citableProducts: readonly CitableProduct[],
): GroundingResult {
  const knownClaimIds = new Set(plan.claims.map((c) => c.id))
  const knownCitableIds = new Set(citableProducts.map((p) => p.id))
  const declaredMentionIds = new Set(draft.productMentions.map((m) => m.id))

  const issues: GroundingIssue[] = []
  const citedClaimIds = new Set<string>()

  for (const text of allProse(draft)) {
    for (const id of claimMarkersIn(text)) {
      if (!knownClaimIds.has(id)) {
        issues.push({ kind: 'unknown_claim_marker', detail: `[[${id}]] cites no claim in the approved plan` })
      } else {
        citedClaimIds.add(id)
      }
    }
    for (const id of placeholdersIn(text)) {
      if (!declaredMentionIds.has(id)) {
        issues.push({ kind: 'undeclared_product_mention', detail: `{{${id}}} has no matching entry in productMentions` })
      }
    }
  }

  for (const mention of draft.productMentions) {
    if (!knownCitableIds.has(mention.id)) {
      issues.push({
        kind: 'unknown_product_mention',
        detail: `productMentions entry "${mention.id}" (product ${mention.productId}) was not among the products the writer was given`,
      })
    }
  }

  return { grounded: issues.length === 0, issues, citedClaimIds: [...citedClaimIds] }
}

/**
 * The universal structural rule: `docs/content-pointers.md` §4, "the answer
 * goes in the first paragraph, before any heading, in every shape" — this is
 * `sizing`'s own named failure condition, restated in the doc for emphasis,
 * but the rule itself applies everywhere, not only to that shape.
 */
export function answerIsFirst(draft: Draft): boolean {
  return draft.intro.trim().length > 0
}

const NON_ANSWER_PHRASES = [
  'it depends on your needs',
  "there's no one-size-fits-all",
  'there is no one-size-fits-all',
  'results will differ',
  'may vary depending on your needs',
]

function containsNonAnswer(text: string): boolean {
  const lower = text.toLowerCase()
  return NON_ANSWER_PHRASES.some((phrase) => lower.includes(phrase))
}

function sectionByHeading(draft: Draft, heading: string): string | null {
  return draft.sections.find((s) => s.heading.toLowerCase().startsWith(heading.toLowerCase()))?.body ?? null
}

export interface ShapeCheckResult {
  readonly passed: boolean
  /** Empty when passed. Otherwise the shape's own named failure condition, or a more specific structural reason. */
  readonly reason: string | null
}

/**
 * The deterministically-checkable half of each shape's named failure
 * condition (`docs/content-pointers.md` §4). Several of the conditions as
 * written are semantic ("causes not ordered by likelihood", "it becomes a
 * catalogue listing") and stay Gate 3's judge's job (`T4.4`) — this checks
 * what structure alone can prove: the section exists, is non-empty, and (for
 * `comparison`) does not fall back on a banned non-answer phrase in place of
 * a verdict.
 */
export function checkShape(shape: ArticleShape, draft: Draft): ShapeCheckResult {
  const skeleton = skeletonFor(shape)

  if (!answerIsFirst(draft)) {
    return { passed: false, reason: skeleton.failureCondition }
  }

  if (shape === 'comparison') {
    const verdict = sectionByHeading(draft, 'Verdict') ?? draft.intro
    if (containsNonAnswer(verdict) || verdict.trim().length === 0) {
      return { passed: false, reason: skeleton.failureCondition }
    }
  }

  if (shape === 'buying_guide') {
    const criteria = draft.sections.filter((s) => s.heading.toLowerCase().startsWith('selection criteria'))
    if (criteria.length === 0 || criteria.every((s) => s.body.trim().length === 0)) {
      return { passed: false, reason: skeleton.failureCondition }
    }
  }

  if (shape === 'troubleshooting') {
    const causes = sectionByHeading(draft, 'Probable causes')
    if (!causes || causes.trim().length === 0) {
      return { passed: false, reason: skeleton.failureCondition }
    }
  }

  if (shape === 'how_to') {
    const steps = sectionByHeading(draft, 'Steps')
    if (!steps || steps.trim().length === 0) {
      return { passed: false, reason: skeleton.failureCondition }
    }
  }

  if (shape === 'informational_commercial') {
    const implications = sectionByHeading(draft, 'Decision implications')
    if (!implications || implications.trim().length === 0) {
      return { passed: false, reason: skeleton.failureCondition }
    }
  }

  if (shape === 'category_explainer') {
    const range = sectionByHeading(draft, 'The range')
    const howToChoose = sectionByHeading(draft, 'How to choose')
    if (!range || !howToChoose) {
      return { passed: false, reason: skeleton.failureCondition }
    }
  }

  return { passed: true, reason: null }
}

/** The FAQ block is conditional, never a default — `docs/content-pointers.md` §4. */
export function faqIsConditional(draft: Draft, researchTurnedUpQuestions: boolean): ShapeCheckResult {
  if (draft.faq.length > 0 && !researchTurnedUpQuestions) {
    return { passed: false, reason: 'an FAQ block was written with no research question behind it' }
  }
  for (const entry of draft.faq) {
    if (entry.answer.trim().length === 0) {
      return { passed: false, reason: `FAQ question "${entry.question}" has no self-contained answer` }
    }
  }
  return { passed: true, reason: null }
}
