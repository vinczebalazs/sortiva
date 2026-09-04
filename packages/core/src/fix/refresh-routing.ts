import type { StorePageType } from '../signals/types'

/**
 * Our own published articles do not take the recommendation path.
 *
 * For a merchant's own collection or product page the answer is a list of edits
 * they apply by hand, because it is their page. For an article we wrote and
 * published for them the answer is different: we can rewrite it ourselves,
 * through the same evidence pack and the same quality gates the first draft
 * went through, and republish it. Handing them a list of edits to paste into a
 * page we control would be busywork.
 *
 * So a page marked as one of ours is routed to the refresh pool — the pool of
 * articles waiting to be rewritten, which the calendar draws from — instead of
 * having a recommendation generated for it.
 *
 * **The pool itself is not built.** It is `T7.2` in the build plan, inside the
 * learning milestone the founder deferred out of the first release. What exists
 * here is the decision and the request shape; nothing consumes the request yet,
 * and until something does, the honest behaviour is to refuse the
 * recommendation rather than produce one this product says it should not
 * produce.
 */

export type OptimizeRoute = 'recommendation' | 'refresh_pool'

/** Which path an OPTIMIZE on a page of this kind takes. */
export function optimizeRouteFor(pageType: StorePageType): OptimizeRoute {
  return pageType === 'article_ours' ? 'refresh_pool' : 'recommendation'
}

/** What the refresh pool would be handed for one of our own articles. */
export interface RefreshPoolRequest {
  readonly accountId: string
  readonly opportunityId: string
  readonly articleUrl: string
  /** Why it arrived: an improve-this-page suggestion landed on a page we published. */
  readonly reason: 'optimize_on_our_own_article'
}

export function refreshPoolRequestFor(input: {
  readonly accountId: string
  readonly opportunityId: string
  readonly articleUrl: string
}): RefreshPoolRequest {
  return { ...input, reason: 'optimize_on_our_own_article' }
}
