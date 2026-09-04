import { describe, expect, it } from 'vitest'
import type { StorePageType } from '../signals/types'
import { optimizeRouteFor, refreshPoolRequestFor } from './refresh-routing'

describe('where an improve-this-page suggestion goes', () => {
  it("sends one of our own published articles to the refresh pool, never to the recommendation writer", () => {
    expect(optimizeRouteFor('article_ours')).toBe('refresh_pool')
  })

  it("hands every page the merchant maintains to the recommendation writer", () => {
    const theirs: StorePageType[] = ['collection', 'product', 'page', 'blog_article', 'other']
    for (const pageType of theirs) {
      expect(optimizeRouteFor(pageType)).toBe('recommendation')
    }
  })

  it('carries why it arrived, so the pool is not left guessing', () => {
    expect(
      refreshPoolRequestFor({
        accountId: 'acct_1',
        opportunityId: 'opp_1',
        articleUrl: '/blogs/news/best-trail-shoes',
      }),
    ).toEqual({
      accountId: 'acct_1',
      opportunityId: 'opp_1',
      articleUrl: '/blogs/news/best-trail-shoes',
      reason: 'optimize_on_our_own_article',
    })
  })
})
