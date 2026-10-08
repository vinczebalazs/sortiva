import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import type { HomeState } from '../../core/screens.ts'
import type { ManualOutcome } from '../../core/topics/manual.ts'
import type { QueuedTopic } from '../../core/topics/queue.ts'
import { useHost } from '../shell/api.tsx'
import { Button, Card, Page, Stack, Tag, Thumbs, Why } from '../ui/components.tsx'
import { formatDay, formatNumber } from '../ui/format.ts'

const POLL_MS = 3000

export function Home() {
  const { t, get } = useHost()
  const [state, setState] = useState<HomeState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const load = async () => {
    clearTimeout(timer.current)
    const next = await get<HomeState>('/api/home')
    setState(next)
    // The first search after setup runs in the background; keep looking until it has finished.
    if (next.findingTopics) timer.current = setTimeout(load, POLL_MS)
  }
  useEffect(() => {
    load()
    return () => clearTimeout(timer.current)
  }, [])

  if (!state) return null
  const zeroUsable = state.thin.thin && state.thin.usable === 0

  return (
    <Page title={t.home.title} actions={state.limited ? <LimitedBadge /> : undefined}>
      {state.thin.thin && <ThinNotice usable={state.thin.usable} total={state.thin.total} />}
      {!zeroUsable && (
        <>
          <TodayCard state={state} onChange={load} />
          <UpNext state={state} onChange={load} />
        </>
      )}
    </Page>
  )
}

function LimitedBadge() {
  const { t, href } = useHost()
  return (
    <span className="ui-row" style={{ gap: 8 }} title={t.home.limitedDetail}>
      <Tag>{t.home.limited}</Tag>
      <Link to={href('settings')} className="ui-small">{t.home.connect}</Link>
    </span>
  )
}

function ThinNotice({ usable, total }: { usable: number; total: number }) {
  const { t, href } = useHost()
  return (
    <Card>
      <div className="ui-row">
        <p style={{ margin: 0 }}>{usable < total ? t.home.thin(usable, total) : t.home.smallStore(total)}</p>
        <Link to={href('products')} style={{ marginLeft: 'auto' }}>{t.home.seeProducts}</Link>
      </div>
    </Card>
  )
}

async function act(post: ReturnType<typeof useHost>['post'], action: 'not_interested' | 'move_to_top' | 'skip', topicId: number) {
  await post('/api/topics', { action, topicId })
}

function TodayCard({ state, onChange }: { state: HomeState; onChange: () => void }) {
  const { t, post } = useHost()
  const today = state.today
  if (state.findingTopics && today.kind === 'nothing') {
    return (
      <Card title={t.home.today}>
        <p style={{ margin: 0, fontWeight: 600 }}>{t.findingTopics}</p>
        <p className="ui-muted" style={{ margin: '4px 0 0' }}>{t.findingTopicsBody}</p>
      </Card>
    )
  }
  if (today.kind === 'nothing') {
    return (
      <Card title={t.home.today}>
        <p style={{ margin: 0, fontWeight: 600 }}>{t.home.nothing}</p>
        <p className="ui-muted" style={{ margin: '4px 0 0' }}>{today.reason === 'queue_empty' && state.topicsUnavailable ? t.home.topicsUnavailable : t.home.nothingWhy[today.reason]}</p>
      </Card>
    )
  }
  if (today.decided) return <TodayArticles state={state} />
  return (
    <Card title={t.home.today}>
      <Stack gap={12}>
        <div>
          <p style={{ margin: 0, fontWeight: 600 }}>{t.home.scheduled(today.topic.workingTitle)}</p>
          <p className="ui-muted" style={{ margin: '4px 0 0' }}>{t.home.writingStarts(state.publishHour)}</p>
        </div>
        <TopicFacts topic={today.topic} />
        <div>
          <Button ghost onClick={async () => { await act(post, 'skip', today.topic.id); onChange() }}>{t.home.skip}</Button>
        </div>
      </Stack>
    </Card>
  )
}

/** The day's decided topic: what became of it, with the one action that fits each state. */
function TodayArticles({ state }: { state: HomeState }) {
  const { t, href, download } = useHost()
  const today = state.today as Extract<HomeState['today'], { kind: 'scheduled' }>
  const h = t.home.article
  const articles = today.articles
  // The topic being worked on now: the day's own, or the one tried after it was held.
  const current = articles.find((a) => a.topicId === today.topic.id)
  const writing = !current || current.status === 'writing'
  return (
    <Card title={t.home.today}>
      <Stack gap={14}>
        {articles.length > 1 && <p className="ui-muted ui-small" style={{ margin: 0 }}>{t.home.secondTry}</p>}
        {articles
          .filter((a) => a.status !== 'writing')
          .map((a) => {
            const line = a.status === 'ready' ? (state.deliveryMode === 'export' ? h.readyExport(a.title) : h.readyPublish(a.title)) : (h[a.status as 'awaiting_review' | 'held' | 'exported'] ?? h.other)(a.title)
            return (
              <div key={a.id} className="ui-stack" style={{ gap: 6 }}>
                <p style={{ margin: 0, fontWeight: 600 }}>{line}</p>
                {a.status === 'held' && a.heldReason && <p className="ui-muted" style={{ margin: 0 }}>{t.heldReasons[a.heldReason]}</p>}
                {a.status === 'ready' && state.deliveryMode === 'auto_publish' && <p className="ui-muted" style={{ margin: 0 }}>{h.readyPublishBody}</p>}
                <div className="ui-row" style={{ gap: 10 }}>
                  {a.status === 'ready' && state.deliveryMode === 'export' && <Button primary onClick={() => download(`/api/articles/${a.id}/download`)}>{h.download}</Button>}
                  <Link to={href('articles', a.id)} className="ui-small">{a.status === 'awaiting_review' ? h.review : a.status === 'held' ? h.seeDetails : h.open}</Link>
                </div>
              </div>
            )
          })}
        {writing && (
          state.writeUnavailable ? (
            <p className="ui-muted" style={{ margin: 0 }}>{t.home.writeUnavailable}</p>
          ) : (
            <div>
              <p style={{ margin: 0, fontWeight: 600 }}>{h.writing(today.topic.workingTitle)}</p>
              <p className="ui-muted" style={{ margin: '4px 0 0' }}>{h.writingBody}</p>
            </div>
          )
        )}
      </Stack>
    </Card>
  )
}

function TopicFacts({ topic }: { topic: QueuedTopic }) {
  const { t, language } = useHost()
  return (
    <>
      <p className="ui-muted ui-small ui-num" style={{ margin: 0 }}>
        {topic.targetQuery} · {topic.searches === null ? t.home.noSearches : t.home.searches(formatNumber(topic.searches, language))}
      </p>
      <Thumbs items={topic.products} more={t.home.more} />
      <Why>{topic.why.kind === 'demand_no_page' ? t.home.why.demand_no_page(formatNumber(topic.why.searches, language)) : t.home.why.low_demand_manual}</Why>
    </>
  )
}

function UpNext({ state, onChange }: { state: HomeState; onChange: () => void }) {
  const { t, post, language } = useHost()
  const [busy, setBusy] = useState<number | null>(null)
  const run = async (action: 'not_interested' | 'move_to_top', id: number) => {
    setBusy(id)
    await act(post, action, id)
    setBusy(null)
    onChange()
  }
  const empty = !state.upNext.length && state.today.kind === 'nothing' && !state.findingTopics
  return (
    <Card title={t.home.upNext}>
      {state.topicsUnavailable && <p className="ui-muted ui-small" style={{ margin: '0 0 18px' }}>{t.home.topicsUnavailable}</p>}
      {empty && !state.topicsUnavailable && (
        <div style={{ marginBottom: 18 }}>
          <p style={{ margin: 0, fontWeight: 600 }}>{t.home.emptyQueue}</p>
          <p className="ui-muted" style={{ margin: '4px 0 0' }}>{t.home.emptyQueueBody}</p>
        </div>
      )}
      {state.upNext.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          {state.upNext.map((topic) => (
            <div className="ui-li" key={topic.id}>
              <div className="ui-stack" style={{ gap: 8, flex: 1, minWidth: 0 }}>
                <div className="ui-row" style={{ gap: 8 }}>
                  <strong style={{ fontWeight: 600 }}>{topic.workingTitle}</strong>
                  {topic.source === 'manual' && <Tag tone="primary">{t.home.addedByYou}</Tag>}
                </div>
                <TopicFacts topic={topic} />
                <div className="ui-row" style={{ gap: 16 }}>
                  <span className="ui-muted ui-small">{topic.expectedDate ? t.home.expected(formatDay(topic.expectedDate, language)) : t.home.expectedPaused}</span>
                  <span style={{ marginLeft: 'auto' }} className="ui-row">
                    <button className="ui-link-button" disabled={busy === topic.id} onClick={() => run('move_to_top', topic.id)}>{t.home.moveToTop}</button>
                    <button className="ui-link-button" disabled={busy === topic.id} onClick={() => run('not_interested', topic.id)}>{t.home.notInterested}</button>
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <AddTopic onAdded={onChange} />
    </Card>
  )
}

type AddResult = ManualOutcome | { kind: 'budget' } | { kind: 'unavailable' } | { kind: 'not_ready' } | { kind: 'error' }

function AddTopic({ onAdded }: { onAdded: () => void }) {
  const { t, post } = useHost()
  const [phrase, setPhrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<AddResult | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!phrase.trim()) return
    setBusy(true)
    setResult(null)
    let body: AddResult
    try {
      body = (await post<AddResult>('/api/topics/add', { phrase })).body
    } catch {
      body = { kind: 'error' }
    }
    setBusy(false)
    setResult(body)
    if (body.kind === 'added' || body.kind === 'moved') {
      setPhrase('')
      onAdded()
    }
  }
  const a = t.home.add
  return (
    <form onSubmit={submit} className="ui-stack" style={{ gap: 10, borderTop: '1px solid var(--line)', paddingTop: 18 }}>
      <div className="ui-field">
        <label htmlFor="add-topic">{a.label}</label>
        <div className="ui-row" style={{ flexWrap: 'nowrap' }}>
          <input id="add-topic" value={phrase} onChange={(e) => setPhrase(e.target.value)} maxLength={200} style={{ flex: 1, minWidth: 0 }} />
          <Button type="submit" disabled={busy || !phrase.trim()}>{busy ? a.checking : a.button}</Button>
        </div>
      </div>
      {result && <AddOutcome result={result} />}
    </form>
  )
}

function AddOutcome({ result }: { result: AddResult }) {
  const { t } = useHost()
  const a = t.home.add
  switch (result.kind) {
    case 'added':
      return <p className="ui-small" style={{ margin: 0, color: 'var(--grn)' }}>{a.added}</p>
    case 'moved':
      return <p className="ui-small" style={{ margin: 0, color: 'var(--grn)' }}>{a.moved}</p>
    case 'existing_page':
      return (
        <p className="ui-small" style={{ margin: 0 }}>
          {a.existingPage} {result.url ? <a href={result.url} target="_blank" rel="noreferrer">{result.title}</a> : <strong>{result.title}</strong>}
        </p>
      )
    case 'cannot_back':
      return (
        <div className="ui-small">
          <p style={{ margin: 0 }}>{a.cannotBack}</p>
          <p className="ui-muted" style={{ margin: '4px 0 0' }}>{result.products.length ? `${a.needFacts} ${result.products.map((p) => p.title).join(', ')}` : a.nothingRelated}</p>
        </div>
      )
    case 'budget':
      return <p className="ui-small" style={{ margin: 0 }}>{a.budget}</p>
    case 'unavailable':
      return <p className="ui-small" style={{ margin: 0 }}>{a.unavailable}</p>
    default:
      return <p className="ui-small" style={{ margin: 0 }}>{a.error}</p>
  }
}
