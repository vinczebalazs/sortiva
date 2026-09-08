'use client'

import { useMemo, useState } from 'react'
import { useUiAnalytics } from '../analytics'
import { criterionLabel, t as defaultTranslate, type StringKey, type Translate } from '../strings'
import { formatDate } from '../opportunities/list'
import type { PostOutcome } from '../opportunities/actions'
import {
  articleActions,
  articleEventLabel,
  articleStateLabel,
  failingCriteria,
} from './articles'
import { saveFile } from './ArticlesScreen'
import { fetchArticleExport, type ArticleExport } from './export'
import type { DownloadFile } from '../opportunities/download'
import { PublishedUrlField } from './PublishedUrlField'
import type { ArticleDetailResponse, QualityReport } from './types'

/**
 * One article, exactly as it would publish, and the decisions left to make
 * about it.
 *
 * **There is no editor here and there is not meant to be one.** A merchant who
 * wants to change the wording does it in their store after publishing, or in
 * their own tools after exporting. Review is one decision — approve or discard —
 * rather than a writing surface, and the absence is a product commitment rather
 * than something not built yet: a test beside this file asserts the rendered
 * screen contains no textarea, no editable region and no field over the body.
 *
 * The state this screen carries hardest is the held one. When a draft failed the
 * quality bar the merchant sees the judge's per-criterion scores and its own
 * written objections, what would change the answer — and the override, because
 * it is their site. The override is deliberately not casual: the dialog restates
 * what the judge objected to and says plainly what publishing anyway costs.
 */

export interface ArticleDetailProps {
  readonly detail: ArticleDetailResponse
  readonly claimedDomain: string
  readonly t?: Translate
  readonly opportunityHref?: string
  /** Posts to `/api/articles/{id}/{action}`; swapped for a double in tests. */
  readonly post?: (path: string, body?: unknown) => Promise<PostOutcome>
  /** Fetches the download from `/api/articles/{id}/export`; swapped for a double in tests. */
  readonly loadExport?: (articleId: string) => Promise<ArticleExport>
  readonly onDone?: () => void
}

export function ArticleDetail({
  detail,
  claimedDomain,
  t = defaultTranslate,
  opportunityHref = '/opportunities',
  post = defaultPost,
  loadExport = (articleId) => fetchArticleExport(articleId, t),
  onDone,
}: ArticleDetailProps) {
  const analytics = useUiAnalytics()
  const { article } = detail
  const [confirming, setConfirming] = useState<'override' | 'discard' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const actions = useMemo(() => articleActions(article), [article])
  const failing = useMemo(() => failingCriteria(detail.qualityReport), [detail.qualityReport])
  /**
   * Fetched once and kept, rather than per button. The route builds all three
   * files from a single reading of the store, which is what stops the Markdown
   * and the HTML disagreeing about a price the merchant changed between clicks.
   */
  const [files, setFiles] = useState<readonly DownloadFile[] | null>(null)

  async function download(extension: string) {
    setBusy(true)
    const ready = files ?? (await loadExport(article.id).then((result) => {
      if (result.ok) {
        setFiles(result.files)
        return result.files
      }
      setNotice(result.message)
      return null
    }))
    setBusy(false)
    const file = ready?.find((candidate) => candidate.filename.endsWith(`.${extension}`))
    if (file) saveFile(file)
  }

  async function send(path: string, body?: unknown, success?: StringKey) {
    setBusy(true)
    const outcome = await post(`/${article.id}/${path}`, body)
    setBusy(false)
    if (!outcome.ok) {
      setNotice(t(articleConflictKey(outcome.conflict)))
      return false
    }
    if (success) setNotice(t(success))
    onDone?.()
    return true
  }

  return (
    <div className="sortiva-article" data-article-id={article.id} data-article-state={article.state}>
      <div className="sortiva-article__main">
        <header className="sortiva-article__head">
          <a href="/content/articles" data-article-back>
            {t('content.article.back')}
          </a>
          <h1>{article.title}</h1>
          <p data-article-state-label>{articleStateLabel(article.state, t)}</p>
        </header>

        <div className="sortiva-article__actions">
          {actions.includes('approve') ? (
            <button
              type="button"
              className="sortiva-content-button sortiva-content-button--primary"
              data-article-action="approve"
              disabled={busy}
              onClick={() => void send('approve', undefined, 'content.article.toast.approved')}
            >
              {t('content.article.approve')}
            </button>
          ) : null}
          {actions.includes('discard') ? (
            <button
              type="button"
              className="sortiva-content-button"
              data-article-action="discard"
              disabled={busy}
              onClick={() => setConfirming('discard')}
            >
              {t('content.article.discard')}
            </button>
          ) : null}
          {actions.includes('publish_anyway') ? (
            <button
              type="button"
              className="sortiva-content-button sortiva-content-button--destructive"
              data-article-action="publish-anyway"
              disabled={busy}
              onClick={() => setConfirming('override')}
            >
              {t('content.article.publishAnyway')}
            </button>
          ) : null}
          {actions.includes('request_refresh') ? (
            <button
              type="button"
              className="sortiva-content-button"
              data-article-action="refresh"
              disabled={busy}
              onClick={() => void send('refresh', undefined, 'content.article.toast.refreshRequested')}
            >
              {t('content.article.requestRefresh')}
            </button>
          ) : null}
          {actions.includes('view_live') && article.publishedUrl ? (
            <a className="sortiva-content-button" href={article.publishedUrl} data-article-action="live">
              {t('content.article.liveUrl')}
            </a>
          ) : null}
          {actions.includes('download')
            ? (['md', 'html', 'json'] as const).map((extension) => (
                <button
                  key={extension}
                  type="button"
                  className="sortiva-content-button"
                  data-article-download={extension}
                  disabled={busy}
                  onClick={() => void download(extension)}
                >
                  {t(downloadKeyFor(`article.${extension}`))}
                </button>
              ))
            : null}
        </div>

        {actions.includes('confirm_url') ? (
          <PublishedUrlField article={article} claimedDomain={claimedDomain} t={t} />
        ) : null}

        {notice ? (
          <p role="status" data-article-notice>
            {notice}
          </p>
        ) : null}

        <p className="sortiva-article__note">{t('content.article.readOnlyNote')}</p>

        {/* The article as it would publish. Rendered and inert: nothing here
            takes a keystroke, and the test beside this file is what keeps it
            that way. */}
        <article
          className="sortiva-article__body"
          data-article-body
          aria-label={t('content.article.bodyLabel')}
          dangerouslySetInnerHTML={{ __html: detail.html }}
        />
      </div>

      <aside className="sortiva-article__aside">
        <section className="sortiva-article__panel">
          <h3>{t('content.article.meta.heading')}</h3>
          <dl>
            <dt>{t('content.article.meta.keyword')}</dt>
            <dd data-meta="keyword">{detail.metadata.targetKeyword}</dd>
            <dt>{t('content.article.meta.slug')}</dt>
            <dd data-meta="slug">{detail.metadata.slug}</dd>
            <dt>{t('content.article.meta.description')}</dt>
            <dd data-meta="description">{detail.metadata.metaDescription}</dd>
            {detail.metadata.familyIds.length > 0 ? (
              <>
                <dt>{t('content.article.meta.families')}</dt>
                <dd data-meta="families">{detail.metadata.familyIds.join(', ')}</dd>
              </>
            ) : null}
            {detail.metadata.opportunityId ? (
              <>
                <dt>{t('content.article.meta.opportunity')}</dt>
                <dd>
                  <a href={`${opportunityHref}#${detail.metadata.opportunityId}`} data-meta="opportunity">
                    {t('content.popover.opportunity')}
                  </a>
                </dd>
              </>
            ) : null}
          </dl>
        </section>

        <section className="sortiva-article__panel">
          <h3>{t('content.article.evidence.heading')}</h3>
          <p className="sortiva-article__note">{t('content.article.evidence.note')}</p>
          <ul data-evidence-pack>
            {detail.evidencePack.map((entry) => (
              <li key={entry.productId}>{entry.title}</li>
            ))}
          </ul>
        </section>

        {detail.qualityReport ? (
          <QualityPanel report={detail.qualityReport} failing={failing} t={t} />
        ) : null}

        <section className="sortiva-article__panel">
          <h3>{t('content.article.history.heading')}</h3>
          <ol data-article-history>
            {detail.history.map((entry) => (
              <li key={`${entry.at}-${entry.event}`} data-history-event={entry.event}>
                {formatDate(entry.at)}
                <span>{articleEventLabel(entry.event, t)}</span>
              </li>
            ))}
          </ol>
        </section>
      </aside>

      {confirming === 'discard' ? (
        <div className="sortiva-override" role="dialog" aria-label={t('content.article.discardConfirmTitle')}>
          <div className="sortiva-override__panel" data-confirm="discard">
            <h3>{t('content.article.discardConfirmTitle')}</h3>
            <p>{t('content.article.discardConfirmBody')}</p>
            <div className="sortiva-confirm__actions">
              <button
                type="button"
                className="sortiva-content-button"
                data-confirm-action="keep"
                onClick={() => setConfirming(null)}
              >
                {t('content.article.keep')}
              </button>
              <button
                type="button"
                className="sortiva-content-button sortiva-content-button--destructive"
                data-confirm-action="discard"
                onClick={() => {
                  setConfirming(null)
                  void send('discard', undefined, 'content.article.toast.discarded')
                }}
              >
                {t('content.article.discard')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirming === 'override' ? (
        <OverrideDialog
          criteria={failing}
          t={t}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null)
            analytics.capture('override_confirmed', {
              article_id: article.id,
              failing_criteria_count: failing.length,
            })
            void send('publish-anyway', { acknowledgedCriteria: failing }, 'content.override.published')
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * The judge's report: a score per criterion and, where it had something to say,
 * its own words.
 *
 * The scores are shown bare rather than against the floor they had to clear.
 * The floors live with every other threshold in the rules package and stamping
 * a second copy of them into a browser would put the quality gate in two places;
 * what the merchant needs from this panel is which criteria the judge objected
 * to, and the objection says that in sentences.
 */
function QualityPanel({
  report,
  failing,
  t,
}: {
  report: QualityReport
  failing: readonly string[]
  t: Translate
}) {
  return (
    <section className="sortiva-article__panel" data-quality-report={report.passed ? 'passed' : 'failed'}>
      <h3>{t('content.article.quality.heading')}</h3>
      <ul className="sortiva-article__scores">
        {Object.entries(report.scores).map(([criterion, score]) => (
          <li key={criterion} data-criterion={criterion} data-criterion-flagged={failing.includes(criterion)}>
            <span>{criterionLabel(criterion, t)}</span>
            <span className="sortiva-article__score">{score}</span>
            {report.justifications[criterion] ? (
              <p className="sortiva-article__justification" data-justification={criterion}>
                {report.justifications[criterion]}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="sortiva-article__note" data-quality-model>
        {t('content.article.quality.model', { model: report.modelId, prompt: report.promptVersion })}
      </p>
    </section>
  )
}

/**
 * The override, styled as a considered decision rather than a warning to click
 * past. It restates what the judge objected to, because an override that does
 * not say what is being overruled is not a decision.
 */
export function OverrideDialog({
  criteria,
  t = defaultTranslate,
  onCancel,
  onConfirm,
}: {
  criteria: readonly string[]
  t?: Translate
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="sortiva-override" role="dialog" aria-label={t('content.override.title')}>
      <div className="sortiva-override__panel" data-confirm="override">
        <h3>{t('content.override.title')}</h3>
        <p data-override-criteria>
          {t('content.override.criteriaIntro', {
            criteria: criteria.map((criterion) => criterionLabel(criterion, t)).join(', '),
          })}
        </p>
        <p>{t('content.override.harm')}</p>
        <ul className="sortiva-override__facts">
          <li>{t('content.override.marked')}</li>
          <li>{t('content.override.excluded')}</li>
        </ul>
        <div className="sortiva-confirm__actions">
          <button
            type="button"
            className="sortiva-content-button"
            data-override-action="cancel"
            onClick={onCancel}
          >
            {t('content.override.cancel')}
          </button>
          <button
            type="button"
            className="sortiva-content-button sortiva-content-button--destructive"
            data-override-action="confirm"
            onClick={onConfirm}
          >
            {t('content.override.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

function downloadKeyFor(filename: string): StringKey {
  if (filename.endsWith('.md')) return 'content.articles.download.markdown'
  if (filename.endsWith('.html')) return 'content.articles.download.html'
  return 'content.articles.download.metadata'
}

/** Every refusal ends in a sentence naming what moved, never a silent no-op. */
export function articleConflictKey(code: string | null): StringKey {
  const keys: Record<string, StringKey> = {
    article_not_in_review: 'content.article.toast.notInReview',
    article_not_rejected: 'content.article.toast.notRejected',
    article_already_published: 'content.toast.alreadyPublished',
    refresh_within_cooldown: 'content.article.toast.cooldown',
  }
  if (code === null) return 'content.toast.failed'
  return keys[code] ?? 'content.toast.conflict'
}

const defaultPost = async (path: string, body?: unknown): Promise<PostOutcome> => {
  try {
    const response = await fetch(`/api/articles${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    if (response.ok) return { ok: true, body: await response.json().catch(() => undefined) }
    const payload = (await response.json().catch(() => null)) as { error?: { code?: string } } | null
    return { ok: false, conflict: payload?.error?.code ?? null }
  } catch {
    return { ok: false, conflict: null }
  }
}
