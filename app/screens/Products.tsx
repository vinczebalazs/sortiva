import { useEffect, useRef, useState } from 'react'
import type { ProductsState } from '../../core/screens.ts'
import { useHost } from '../shell/api.tsx'
import { Button, Card, Page, Tag } from '../ui/components.tsx'
import { formatMoment } from '../ui/format.ts'

const POLL_MS = 2000

/** Read-only: the store's own product page is where details are edited. */
export function Products() {
  const { t, get, post, adminLink, language } = useHost()
  const [state, setState] = useState<ProductsState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const load = async () => {
    clearTimeout(timer.current)
    const next = await get<ProductsState>('/api/products')
    setState(next)
    if (next.sync.running) timer.current = setTimeout(load, POLL_MS)
  }
  useEffect(() => {
    load()
    return () => clearTimeout(timer.current)
  }, [])
  if (!state) return null

  const p = t.products
  const sync = state.sync
  const syncNow = async () => {
    setState({ ...state, sync: { ...sync, running: true, done: 0, total: 0 } })
    await post('/api/sync', {})
    load()
  }
  return (
    <Page
      title={p.title}
      subtitle={p.intro}
      actions={
        <>
          <span className="ui-muted ui-small">{p.lastSynced(sync.lastSyncedAt ? formatMoment(String(sync.lastSyncedAt), language) : p.never)}</span>
          <Button primary disabled={sync.running} onClick={syncNow}>{sync.running ? p.syncing(sync.done, sync.total) : p.syncNow}</Button>
        </>
      }
    >
      <Card>
        <div className="ui-table-scroll">
          <table className="ui-table">
            <thead>
              <tr>
                <th style={{ width: 48 }} />
                <th>{p.product}</th>
                <th>{p.type}</th>
                <th>{p.canWrite}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.products.map((row) => (
                <tr key={row.id}>
                  <td>{row.image ? <img src={row.image} alt="" loading="lazy" /> : <img alt="" />}</td>
                  <td style={{ fontWeight: 600 }}>{row.title}</td>
                  <td className="ui-muted">{row.productType}</td>
                  <td>{row.usable ? <Tag tone="success">{p.yes(row.facts)}</Tag> : <Tag>{p.needs}</Tag>}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <a className="ui-small" href={adminLink('products', row.platformId)} target="_top">{t.common.openInShopify}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Page>
  )
}
