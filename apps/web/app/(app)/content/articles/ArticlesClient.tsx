'use client'

import {
  ArticlesScreen,
  articleFiles,
  type ArticleDetailResponse,
  type ArticlesResponse,
  type ArticleSummary,
  type DownloadFile,
} from '@sortiva/ui'

/**
 * The library's two browser-side jobs, kept out of the server component that
 * draws it.
 *
 * The download buttons need the article itself — the body, the metadata block —
 * which the list response does not carry, so the file is built after a read of
 * that one article rather than by fetching every article's body to draw a table.
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
  async function download(article: ArticleSummary): Promise<readonly DownloadFile[]> {
    try {
      const response = await fetch(`/api/articles/${article.id}`, {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) return []
      return articleFiles((await response.json()) as ArticleDetailResponse)
    } catch {
      return []
    }
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
