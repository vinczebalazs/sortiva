import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import type { ArticleRow, ArticlesState, ArticleStatus } from '../../core/articles.ts'
import { useHost } from '../shell/api.tsx'
import { Button, Card, Page, Tag } from '../ui/components.tsx'
import { formatMoment, formatNumber } from '../ui/format.ts'

const FILTERS: (ArticleStatus | 'all')[] = ['all', 'awaiting_review', 'ready', 'exported', 'published', 'draft_in_shopify', 'held', 'removed_by_merchant']

export function statusLabel(t: ReturnType<typeof useHost>['t'], status: ArticleStatus, mode: 'export' | 'auto_publish'): string {
  return t.articles.statuses[status === 'ready' ? `ready_${mode}` : status] ?? status
}

export function StatusTag({ status, mode }: { status: ArticleStatus; mode: 'export' | 'auto_publish' }) {
  const { t } = useHost()
  const tone = status === 'held' ? 'critical' : status === 'awaiting_review' ? 'primary' : status === 'published' || status === 'exported' || status === 'ready' ? 'success' : undefined
  return <Tag tone={tone}>{statusLabel(t, status, mode)}</Tag>
}

export function Articles() {
  const { t, get, href, language } = useHost()
  const [filter, setFilter] = useState<ArticleStatus | 'all'>('all')
  const [state, setState] = useState<ArticlesState | null>(null)
  const load = async () => setState(await get<ArticlesState>(`/api/articles${filter === 'all' ? '' : `?status=${filter}`}`))
  useEffect(() => {
    load()
  }, [filter])
  if (!state) return null
  const a = t.articles

  return (
    <Page title={a.title}>
      <div className="ui-row" style={{ gap: 8 }} role="group">
        {FILTERS.map((f) => (
          <button key={f} className="ui-chip" data-selected={filter === f || undefined} onClick={() => setFilter(f)}>
            {f === 'all' ? a.all : statusLabel(t, f, state.deliveryMode)}
          </button>
        ))}
      </div>
      <Card>
        {state.articles.length === 0 ? (
          <p className="ui-muted" style={{ margin: 0 }}>{a.empty}</p>
        ) : (
          <div className="ui-table-scroll">
            <table className="ui-table">
              <thead>
                <tr>
                  <th>{a.articleCol}</th>
                  <th>{a.written}</th>
                  <th>{a.status}</th>
                  {!state.limited && <th>{a.results}</th>}
                </tr>
              </thead>
              <tbody>
                {state.articles.map((row) => (
                  <tr key={row.id}>
                    <td style={{ fontWeight: 600, minWidth: 220 }}>
                      <Link to={href('articles', row.id)}>{row.title}</Link>
                      {row.askForUrl && <WhereField row={row} onSaved={load} />}
                    </td>
                    <td className="ui-muted ui-num" style={{ whiteSpace: 'nowrap' }}>{row.writtenAt ? formatMoment(row.writtenAt, language) : '—'}</td>
                    <td><StatusTag status={row.status} mode={state.deliveryMode} /></td>
                    {!state.limited && (
                      <td className="ui-small ui-num">
                        {row.results ? (
                          <>
                            {a.clicks(formatNumber(row.results.clicks, language), formatNumber(row.results.impressions, language))}
                            <div className="ui-muted">{row.results.label ? a.labels[row.results.label] : a.tooNew}</div>
                          </>
                        ) : (
                          <span className="ui-muted">{a.tooNew}</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {state.limited && state.articles.length > 0 && <p className="ui-muted ui-small" style={{ margin: '14px 0 0' }}>{a.limitedNote}</p>}
      </Card>
    </Page>
  )
}

/** "Where did you publish it?": until it is answered, an exported article cannot have results. */
export function WhereField({ row, onSaved }: { row: Pick<ArticleRow, 'id'>; onSaved: () => void }) {
  const { t, post } = useHost()
  const [url, setUrl] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const res = await post(`/api/articles/${row.id}`, { action: 'published_url', url })
    setBusy(false)
    if (res.status === 200) onSaved()
    else setInvalid(true)
  }
  return (
    <form onSubmit={submit} className="ui-field" style={{ marginTop: 8, fontWeight: 400 }}>
      <label htmlFor={`where-${row.id}`} className="ui-small">{t.articles.where}</label>
      <div className="ui-row" style={{ flexWrap: 'nowrap', gap: 8 }}>
        <input id={`where-${row.id}`} value={url} placeholder={t.articles.wherePlaceholder} onChange={(e) => { setUrl(e.target.value); setInvalid(false) }} style={{ flex: 1, minWidth: 0 }} aria-invalid={invalid} />
        <Button type="submit" disabled={busy || !url.trim()}>{t.articles.whereSave}</Button>
      </div>
      {invalid && <span className="ui-field-error">{t.articles.whereInvalid}</span>}
    </form>
  )
}
