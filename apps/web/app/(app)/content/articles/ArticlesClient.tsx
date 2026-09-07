'use client'

import {
  ArticlesScreen,
  fetchArticleExport,
  type ArticleExport,
  type ArticlesResponse,
  type ArticleSummary,
} from '@sortiva/ui'

/**
 * The library's two browser-side jobs, kept out of the server component that
 * draws it.
 *
 * The download buttons ask the export route for the files rather than building
 * them here out of the article-detail response. That response answers with an
 * empty body when the article cannot be rendered, so building from it handed a
 * merchant a title and nothing else in the one case they needed telling about.
 * Confirming a published address is a write, so it happens here too.
 */

export function ArticlesClient({
  data,
  claimedDomain,
  firstArticleDate,
}: {
  data: ArticlesResponse
  claimedDomain: string
  firstArticleDate: string | null
}) {
  async function download(article: ArticleSummary): Promise<ArticleExport> {
    return fetchArticleExport(article.id)
  }

  async function confirmUrl(article: ArticleSummary, url: string): Promise<boolean> {
    try {
      const response = await fetch(`/api/articles/${article.id}/published-url`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      return response.ok
    } catch {
      return false
    }
  }

  return (
    <ArticlesScreen
      data={data}
      claimedDomain={claimedDomain}
      firstArticleDate={firstArticleDate}
      onDownload={download}
      onConfirmUrl={confirmUrl}
    />
  )
}
