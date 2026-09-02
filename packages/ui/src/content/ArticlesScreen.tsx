'use client'

import { useMemo, useState } from 'react'
import { t as defaultTranslate, type StringKey, type Translate } from '../strings'
import { formatDate } from '../opportunities/list'
import type { DownloadFile } from '../opportunities/download'
import {
  articleCounts,
  articleStateLabel,
  deliveryLabel,
  filterArticles,
  needsAttention,
  outcomeLabel,
  type ArticleFilter,
} from './articles'
import { PublishedUrlField } from './PublishedUrlField'
import type { ArticlesResponse, ArticleState, ArticleSummary } from './types'

/**
 * Every article this store has, newest first.
 *
 * Two things on this table are deliberate and easy to get wrong. An article
 * younger than the measurement window reads as "too new" rather than as a zero:
 * an article published on Tuesday has no verdict, and showing a dash where a
 * result will be is honest where showing nought would look like failure. And an
 * exported article whose published address nobody told us shows a quiet tag
 * saying so — it is invisible to every measurement we make until that address
 * arrives, and the merchant is the only one who can supply it.
 *
 * Badges stay quiet. An override is recorded, never scolded.
 */

const STATES: readonly ArticleState[] = ['draft', 'in_review', 'published', 'rejected', 'discarded']

export interface ArticlesScreenProps {
  readonly data: ArticlesResponse
  /** The domain the account claimed. A published address must be on it. */
  readonly claimedDomain: string
  readonly t?: Translate
  /** The day the first planned article is due, for the empty state. */
  readonly firstArticleDate?: string | null
  readonly articleHref?: (articleId: string) => string
  readonly onDownload?: (article: ArticleSummary) => Promise<readonly DownloadFile[]> | readonly DownloadFile[]
  readonly onConfirmUrl?: (article: ArticleSummary, url: string) => Promise<boolean>
}

export function ArticlesScreen({
  data,
  claimedDomain,
  t = defaultTranslate,
  firstArticleDate = null,
  articleHref = (id) => `/content/articles/${id}`,
  onDownload,
  onConfirmUrl,
}: ArticlesScreenProps) {
  const [filter, setFilter] = useState<ArticleFilter>({})
  const counts = useMemo(() => articleCounts(data.articles), [data.articles])
  const rows = useMemo(() => filterArticles(data.articles, filter), [data.articles, filter])

  if (data.articles.length === 0) {
    return (
      <section className="sortiva-articles">
        <h1>{t('content.articles.heading')}</h1>
        <div className="sortiva-articles__empty" data-articles-empty>
          {firstArticleDate
            ? t('content.articles.empty', { date: formatDate(firstArticleDate) })
            : t('content.articles.emptyNoDate')}
        </div>
      </section>
    )
  }

  return (
    <section className="sortiva-articles">
      <header>
        <h1>{t('content.articles.heading')}</h1>
        <p data-articles-counts>{t('content.articles.counts', {
            published: counts.published,
            inReview: counts.inReview,
            held: counts.held,
          })}</p>
      </header>

      <div className="sortiva-articles__filters" role="group" aria-label={t('content.articles.filterLabel')}>
        <button
          type="button"
          data-articles-filter="all"
          aria-pressed={filter.states === undefined && !filter.hasPerformance && !filter.needsAttention}
          onClick={() => setFilter({})}
        >
          {t('content.articles.filter.all')}
        </button>
        {STATES.map((state) => (
          <button
            key={state}
            type="button"
            data-articles-filter={state}
            aria-pressed={filter.states?.includes(state) ?? false}
            onClick={() => setFilter({ states: [state] })}
          >
            {articleStateLabel(state, t)}
          </button>
        ))}
        <button
          type="button"
          data-articles-filter="has-performance"
          aria-pressed={filter.hasPerformance ?? false}
          onClick={() => setFilter({ hasPerformance: true })}
        >
          {t('content.articles.filter.hasPerformance')}
        </button>
        <button
          type="button"
          data-articles-filter="needs-attention"
          aria-pressed={filter.needsAttention ?? false}
          onClick={() => setFilter({ needsAttention: true })}
        >
          {t('content.articles.filter.needsAttention')}
        </button>
      </div>

      <table className="sortiva-articles__table">
        <thead>
          <tr>
            <th>{t('content.articles.col.title')}</th>
            <th>{t('content.articles.col.state')}</th>
            <th>{t('content.articles.col.delivery')}</th>
            <th>{t('content.articles.col.published')}</th>
            <th>{t('content.articles.col.clicks')}</th>
            <th>{t('content.articles.col.position')}</th>
            <th>{t('content.articles.col.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((article) => (
            <tr
              key={article.id}
              data-article-id={article.id}
              data-article-state={article.state}
              data-article-delivery={article.delivery}
              data-article-attention={needsAttention(article) ? 'true' : 'false'}
            >
              <td>
                <a href={articleHref(article.id)}>{article.title}</a>
                <Badges article={article} t={t} />
              </td>
              <td>{articleStateLabel(article.state, t)}</td>
              <td>{deliveryLabel(article.delivery, t)}</td>
              <td>{article.publishedAt ? formatDate(article.publishedAt) : dash(t)}</td>
              <td data-article-clicks>
                {article.performance ? article.performance.clicks28d : dash(t)}
              </td>
              <td data-article-position>
                {article.performance ? article.performance.position : dash(t)}
              </td>
              <td>
                {article.performance ? (
                  <span data-article-label={article.performance.label}>
                    {outcomeLabel(article.performance.label, t)}
                  </span>
                ) : (
                  <span data-article-label="unrated">{outcomeLabel('unrated', t)}</span>
                )}
                {article.delivery === 'export' && article.state === 'published' ? (
                  <ExportRow
                    article={article}
                    claimedDomain={claimedDomain}
                    t={t}
                    onDownload={onDownload}
                    onConfirmUrl={onConfirmUrl}
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/** An absence of data, which is never a nought. */
function dash(t: Translate): string {
  return t('content.articles.notMeasured' as StringKey)
}

function Badges({ article, t }: { article: ArticleSummary; t: Translate }) {
  const badges: { key: string; label: string }[] = []
  if (article.publishedViaOverride) {
    badges.push({ key: 'override', label: t('content.articles.badge.override') })
  }
  if (article.repaired) badges.push({ key: 'repaired', label: t('content.articles.badge.repaired') })
  if (article.refreshedCount > 0) {
    badges.push({
      key: 'refreshed',
      label: t('content.articles.badge.refreshed', { count: article.refreshedCount }),
    })
  }
  if (article.state === 'published' && article.delivery === 'export' && article.publishedUrl === null) {
    badges.push({ key: 'awaiting-url', label: t('content.articles.badge.awaitingUrl') })
  }
  if (badges.length === 0) return null

  return (
    <span className="sortiva-articles__badges">
      {badges.map((badge) => (
        <span key={badge.key} className="sortiva-articles__badge" data-article-badge={badge.key}>
          {badge.label}
        </span>
      ))}
    </span>
  )
}

/**
 * What an export merchant does with a published article: take the files, and
 * tell us where they put them. The second is not a nicety — without it the
 * article is invisible to attribution for good.
 */
function ExportRow({
  article,
  claimedDomain,
  t,
  onDownload,
  onConfirmUrl,
}: {
  article: ArticleSummary
  claimedDomain: string
  t: Translate
  onDownload?: ArticlesScreenProps['onDownload']
  onConfirmUrl?: ArticlesScreenProps['onConfirmUrl']
}) {
  const [files, setFiles] = useState<readonly DownloadFile[] | null>(null)

  async function load() {
    if (files) return files
    const loaded = (await onDownload?.(article)) ?? []
    setFiles(loaded)
    return loaded
  }

  return (
    <div className="sortiva-articles__export" data-article-export={article.id}>
      <div className="sortiva-articles__downloads">
        {(['md', 'html', 'json'] as const).map((extension) => (
          <button
            key={extension}
            type="button"
            data-article-download={extension}
            onClick={() => {
              void load().then((loaded) => {
                const file = loaded.find((entry) => entry.filename.endsWith(`.${extension}`))
                if (file) saveFile(file)
              })
            }}
          >
            {t(
              (extension === 'md'
                ? 'content.articles.download.markdown'
                : extension === 'html'
                  ? 'content.articles.download.html'
                  : 'content.articles.download.metadata') as StringKey,
            )}
          </button>
        ))}
      </div>
      <PublishedUrlField
        article={article}
        claimedDomain={claimedDomain}
        t={t}
        onConfirm={onConfirmUrl}
      />
    </div>
  )
}

/** Hands a file to the browser. No-op where there is no browser, so a test can call it. */
export function saveFile(file: DownloadFile): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = file.filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
