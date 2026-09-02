import type { ArticlesResponse, CalendarResponse } from '@sortiva/ui'
import '@sortiva/ui/styles/opportunities.css'
import '@sortiva/ui/styles/content.css'
import { getJson, requestContext } from '../../_lib/api'
import { loadShellState } from '../../_lib/shell-state'
import { ContentTabs } from '../_lib/nav'
import { ArticlesClient } from './ArticlesClient'

/**
 * Everything this store has had written, in one table.
 *
 * The claimed domain is read alongside the list because one column depends on
 * it: an exported article's published address is checked against the domain the
 * account claimed before it is sent, so that a mistyped address cannot credit
 * this store with another store's search traffic.
 *
 * The empty state names the day the first article is due, which is the earliest
 * planned topic on the calendar rather than anything the articles response
 * knows — so the calendar is read for that one date and nothing else.
 */

export const dynamic = 'force-dynamic'

const EMPTY: ArticlesResponse = { articles: [], cursor: null }

export default async function ArticlesPage() {
  const request = await requestContext()
  const today = new Date().toISOString().slice(0, 10)
  const horizon = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10)

  const [data, calendar, shell] = await Promise.all([
    getJson<ArticlesResponse>('/api/articles', request),
    getJson<CalendarResponse>(`/api/calendar?from=${today}&to=${horizon}`, request),
    loadShellState(),
  ])

  const firstPlanned = (calendar?.topics ?? [])
    .filter((topic) => topic.state === 'planned' && topic.scheduledFor >= today)
    .map((topic) => topic.scheduledFor)
    .sort()[0]

  return (
    <>
      <ContentTabs current="articles" />
      <ArticlesClient
        data={data ?? EMPTY}
        claimedDomain={shell.account.domain?.normalized ?? ''}
        firstArticleDate={firstPlanned ?? null}
      />
    </>
  )
}
