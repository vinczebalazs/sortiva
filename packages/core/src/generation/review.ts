import type { ConflictCode } from '../api/errors'

/**
 * Where an article that has just passed the quality bar comes to rest, and what
 * a merchant may then do with it.
 *
 * Draft review is a per-account setting, off by default. With it off, a passing
 * article is simply ready to go out and nobody is asked anything. With it on,
 * it waits for the merchant, who has exactly two answers available: keep it or
 * throw it away. **There is deliberately no editor** — someone who wants to
 * reword a sentence does it in their own store after it is published, which
 * keeps review a one-decision surface rather than a text-editing product.
 */

/** The pair of states a Gate-3 pass writes: one for the article, one for the calendar entry it came from. */
export interface PassLanding {
  readonly articleState: 'draft' | 'in_review'
  readonly topicState: 'generating' | 'in_review'
  /** True when the merchant is being asked for a decision before anything goes out. */
  readonly awaitsReview: boolean
}

export function landingForPass(draftReview: boolean): PassLanding {
  return draftReview
    ? { articleState: 'in_review', topicState: 'in_review', awaitsReview: true }
    : { articleState: 'draft', topicState: 'generating', awaitsReview: false }
}

/**
 * `draft` means "delivery may take this" and nothing more.
 *
 * It is worth stating because `draft` is also the state an article sits in
 * *before* it has been graded — the row is created early so the claim plan can
 * hang off it. What separates the two is not the article at all: it is whether
 * a Gate 3 decision exists for its topic. So anything asking "is this ready to
 * publish" must ask both questions, and `articlesReadyForDelivery`
 * (`packages/db`) is the one read that does. A crash between the writer and
 * the judge therefore leaves a row that looks unfinished, which is what it is,
 * rather than one that looks ready to publish.
 *
 * An approved article and an override-published one both land back in `draft`
 * for the same reason: the merchant has already given their answer, and asking
 * again at the publish hour would be asking twice. See DECISIONS 2026-09-03
 * T4.5.
 */
export const READY_FOR_DELIVERY_ARTICLE_STATE = 'draft' as const

/** The merchant's two answers, and nothing else. Adding a third here would be adding an editor. */
export type ReviewDecision = 'approve' | 'discard'

/**
 * Refusing a review action on an article that has moved on. Both actions answer
 * with the same code the frozen route contract names for them
 * (`packages/core/src/api/routes.ts`), because from the merchant's side the
 * situation is identical: the draft they were looking at is no longer waiting.
 */
export const REVIEW_CONFLICT_CODE: ConflictCode = 'article_not_in_review'

/** A published article is past the point of either answer, and says so distinctly. */
export const REVIEW_PUBLISHED_CONFLICT_CODE: ConflictCode = 'article_already_published'

export function reviewConflictFor(actualState: string): ConflictCode {
  return actualState === 'published' ? REVIEW_PUBLISHED_CONFLICT_CODE : REVIEW_CONFLICT_CODE
}
