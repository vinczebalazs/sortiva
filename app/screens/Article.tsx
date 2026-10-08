import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import type { ArticleDetail } from '../../core/articles.ts'
import { useHost } from '../shell/api.tsx'
import { Button, Card, Page, Why } from '../ui/components.tsx'
import { formatNumber } from '../ui/format.ts'
import { StatusTag, WhereField } from './Articles.tsx'

// The preview frame gets plain readable defaults; the store's own theme styles the real thing.
const FRAME_STYLE = `<style>body{font:16px/1.65 Georgia,serif;color:#1d1d1f;max-width:680px;margin:24px auto;padding:0 16px}h2,h3{font-family:system-ui,sans-serif;line-height:1.3}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 10px}a{color:#2453d6}</style>`

export function Article({ id }: { id: number }) {
  const { t, get, href } = useHost()
  const [detail, setDetail] = useState<ArticleDetail | null | 'missing'>(null)
  const load = async () => {
    try {
      setDetail(await get<ArticleDetail>(`/api/articles/${id}`))
    } catch {
      setDetail('missing')
    }
  }
  useEffect(() => {
    load()
  }, [id])
  if (detail === null) return null
  if (detail === 'missing' || !('id' in detail)) {
    return (
      <Page title={t.articles.title}>
        <Card><p style={{ margin: 0 }}>{t.article.notFound}</p></Card>
      </Page>
    )
  }

  return (
    <Page title={detail.title} actions={<StatusTag status={detail.status} mode={detail.deliveryMode} />}>
      <p style={{ margin: '-8px 0 0' }}><Link className="ui-small" to={href('articles')}>← {t.article.back}</Link></p>
      <Actions detail={detail} onChange={load} />
      <div className="ui-article-grid">
        <Preview detail={detail} />
        <BuiltOn detail={detail} />
      </div>
    </Page>
  )
}

function Preview({ detail }: { detail: ArticleDetail }) {
  const { t } = useHost()
  const [tab, setTab] = useState<'preview' | 'markdown'>('preview')
  return (
    <Card
      title={tab === 'preview' ? t.article.preview : t.article.markdown}
      aside={
        <span className="ui-row" style={{ gap: 6 }}>
          <button className="ui-chip" data-selected={tab === 'preview' || undefined} onClick={() => setTab('preview')}>{t.article.preview}</button>
          <button className="ui-chip" data-selected={tab === 'markdown' || undefined} onClick={() => setTab('markdown')}>{t.article.markdown}</button>
        </span>
      }
    >
      {tab === 'preview' ? (
        // The exact HTML we would send, sandboxed: no scripts, and links open outside the app.
        <iframe className="ui-preview" title={t.article.preview} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={`${FRAME_STYLE}<base target="_blank"><h1>${escapeHtml(detail.title)}</h1>${detail.html ?? ''}`} />
      ) : (
        <pre className="ui-markdown">{detail.markdown}</pre>
      )}
    </Card>
  )
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function BuiltOn({ detail }: { detail: ArticleDetail }) {
  const { t, language, adminLink } = useHost()
  const a = t.article
  const languageName = t.languages[detail.language]
  return (
    <div className="ui-stack" style={{ gap: 16, minWidth: 0 }}>
      <Card title={a.checks}>
        <ul className="ui-checks">
          {detail.checks.map((c) => (
            <li key={c.id} data-ok={c.ok || undefined}>
              <span aria-hidden="true">{c.ok ? '✓' : '✕'}</span>
              <div>
                <span>{c.id === 'language' ? a.languageCheck(languageName) : (a.checkNames[c.id] ?? c.id)}</span>
                {!c.ok && c.problem?.sentence && <q className="ui-small">{c.problem.sentence}</q>}
              </div>
            </li>
          ))}
        </ul>
        {detail.scores && (
          <div className="ui-stack" style={{ gap: 8, marginTop: 14 }}>
            {(Object.keys(detail.scores) as (keyof typeof detail.scores)[]).map((k) => (
              <div key={k} className="ui-score">
                <span className="ui-small">{a.scores[k]}</span>
                <span className="ui-bars" aria-label={`${detail.scores![k]} / 5`}>
                  {[1, 2, 3, 4, 5].map((n) => <i key={n} data-on={n <= detail.scores![k] || undefined} />)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card title={a.topic}>
        <p className="ui-muted ui-small ui-num" style={{ margin: '0 0 8px' }}>
          {detail.topic.targetQuery} · {detail.topic.searches === null ? t.home.noSearches : t.home.searches(formatNumber(detail.topic.searches, language))}
        </p>
        <Why>{detail.topic.why.kind === 'demand_no_page' ? t.home.why.demand_no_page(formatNumber(detail.topic.why.searches, language)) : t.home.why.low_demand_manual}</Why>
      </Card>
      <Card title={a.products}>
        <ul className="ui-plain">
          {detail.products.map((p) => (
            <li key={p.id}>
              <a href={adminLink('products', p.platformId)} target="_top">{p.title}</a>
              {p.gone && <span className="ui-muted ui-small"> · {a.gone}</span>}
            </li>
          ))}
        </ul>
      </Card>
      <Card title={a.facts}>
        <p className="ui-muted ui-small" style={{ margin: '0 0 10px' }}>{a.factsHint}</p>
        <ul className="ui-plain ui-small">
          {detail.facts.map((f) => (
            <li key={f.id}>
              {f.text} <span className="ui-muted">— {f.product}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}

function Actions({ detail, onChange }: { detail: ArticleDetail; onChange: () => void }) {
  const { t, post, download } = useHost()
  const a = t.article
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const act = async (action: 'approve' | 'discard') => {
    setBusy(true)
    await post(`/api/articles/${detail.id}`, { action })
    setBusy(false)
    onChange()
  }
  const downloadZip = async () => {
    setBusy(true)
    await download(`/api/articles/${detail.id}/download`)
    setBusy(false)
    onChange()
  }

  if (detail.status === 'held') {
    return (
      <div className="ui-banner" data-tone="critical">
        <div>
          <strong>{detail.heldReason ? t.heldReasons[detail.heldReason] : ''}</strong>
          {detail.heldProblem?.sentence && <q style={{ display: 'block', marginTop: 4 }}>{detail.heldProblem.sentence}</q>}
          <p style={{ margin: '6px 0 0' }}>{a.heldNote}</p>
        </div>
      </div>
    )
  }
  if (detail.status === 'awaiting_review') {
    return (
      <Card>
        {confirming ? (
          <div className="ui-row">
            <span>{a.confirmDiscard}</span>
            <span className="ui-row" style={{ marginLeft: 'auto', gap: 8 }}>
              <Button ghost onClick={() => setConfirming(false)}>{a.cancel}</Button>
              <Button disabled={busy} onClick={() => act('discard')}>{a.confirmDiscardYes}</Button>
            </span>
          </div>
        ) : (
          <div className="ui-row" style={{ gap: 10 }}>
            <Button primary disabled={busy} onClick={() => act('approve')}>{a.approve}</Button>
            <Button ghost disabled={busy} onClick={() => setConfirming(true)}>{a.discard}</Button>
          </div>
        )}
      </Card>
    )
  }
  if ((detail.status === 'ready' || detail.status === 'exported') && detail.deliveryMode === 'export') {
    return (
      <Card>
        <div className="ui-row" style={{ gap: 12 }}>
          <Button primary disabled={busy} onClick={downloadZip}>{a.download}</Button>
          {detail.status === 'ready' && <span className="ui-muted ui-small">{a.approvedExport}</span>}
        </div>
        {detail.status === 'exported' && !detail.publishedUrl && <WhereField row={detail} onSaved={onChange} />}
        {detail.publishedUrl && <p className="ui-small" style={{ margin: '10px 0 0' }}><a href={detail.publishedUrl} target="_blank" rel="noreferrer">{a.viewInStore}</a></p>}
      </Card>
    )
  }
  if (detail.status === 'ready') return <p className="ui-muted ui-small" style={{ margin: 0 }}>{a.approvedPublish}</p>
  if (detail.publishedUrl) return <p className="ui-small" style={{ margin: 0 }}><a href={detail.publishedUrl} target="_blank" rel="noreferrer">{a.viewInStore}</a></p>
  return null
}
