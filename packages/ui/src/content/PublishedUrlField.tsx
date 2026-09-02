'use client'

import { useState } from 'react'
import { t as defaultTranslate, type Translate } from '../strings'
import { checkPublishedUrl } from './articles'
import type { ArticleSummary } from './types'

/**
 * Where an exported article ended up, in the merchant's own words.
 *
 * This is the one field in the product where a wrong answer does something
 * worse than fail: search performance is attributed by URL, so an address on
 * somebody else's site would credit this store with another store's traffic. So
 * it is checked against the domain this account claimed before it is sent, and
 * the merchant is told which of the two things went wrong — a malformed address
 * or the right shape on the wrong site — because those need different fixes.
 */

export interface PublishedUrlFieldProps {
  readonly article: ArticleSummary
  readonly claimedDomain: string
  readonly t?: Translate
  readonly onConfirm?: (article: ArticleSummary, url: string) => Promise<boolean>
}

export function PublishedUrlField({
  article,
  claimedDomain,
  t = defaultTranslate,
  onConfirm,
}: PublishedUrlFieldProps) {
  const [open, setOpen] = useState(article.publishedUrl === null)
  const [value, setValue] = useState(article.publishedUrl ?? '')
  const [problem, setProblem] = useState<'malformed' | 'off_domain' | null>(null)
  const [saved, setSaved] = useState(false)

  if (!open) {
    return (
      <div className="sortiva-articles__url" data-article-url="confirmed">
        <span data-article-url-value>{article.publishedUrl}</span>
        <button type="button" onClick={() => setOpen(true)}>
          {t('content.articles.urlEdit')}
        </button>
      </div>
    )
  }

  return (
    <form
      className="sortiva-articles__url"
      data-article-url="pending"
      onSubmit={(event) => {
        event.preventDefault()
        const check = checkPublishedUrl(value, claimedDomain)
        if (!check.ok) {
          setProblem(check.problem)
          return
        }
        setProblem(null)
        void Promise.resolve(onConfirm?.(article, check.url) ?? true).then((ok) => {
          if (ok) {
            setSaved(true)
            setOpen(false)
          }
        })
      }}
    >
      <label className="sortiva-content-field">
        <span className="sortiva-content-field__label">{t('content.articles.urlLabel')}</span>
        <input
          className="sortiva-content-field__input"
          name={`published-url-${article.id}`}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <button type="submit" data-article-url-submit>
        {t('content.articles.markPublished')}
      </button>
      {problem ? (
        <p className="sortiva-articles__error" role="alert" data-article-url-error={problem}>
          {problem === 'off_domain'
            ? t('content.articles.urlInvalid', { domain: claimedDomain })
            : t('content.articles.urlMalformed')}
        </p>
      ) : null}
      {saved ? <p data-article-url-saved>{t('content.articles.urlSaved')}</p> : null}
    </form>
  )
}
