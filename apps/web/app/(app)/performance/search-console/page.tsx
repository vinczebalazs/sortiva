import { SearchConsoleScreen, type SearchConsoleResponse } from '@sortiva/ui'
import '@sortiva/ui/styles/content.css'
import '@sortiva/ui/styles/opportunities.css'
import '@sortiva/ui/styles/performance.css'
import { getJson, requestContext } from '../../_lib/api'
import { PerformanceTabs } from '../_lib/nav'

/**
 * The Search Console tab: the queries a store is found for and the pages that
 * answer them, each row a way into the opportunity about it.
 *
 * Both tables are read here so the page draws in one frame, and both over the
 * same window — two tables covering different stretches of time sitting side by
 * side would invite a comparison that means nothing. The window buttons in the
 * screen re-read both together for the same reason.
 */

export const dynamic = 'force-dynamic'

const EMPTY: SearchConsoleResponse = { rows: [], cursor: null }

export default async function SearchConsolePage() {
  const request = await requestContext()
  const [queries, pages] = await Promise.all([
    getJson<SearchConsoleResponse>(
      '/api/performance/search-console?dimension=query&window=28d',
      request,
    ),
    getJson<SearchConsoleResponse>(
      '/api/performance/search-console?dimension=page&window=28d',
      request,
    ),
  ])

  return (
    <>
      <PerformanceTabs current="search-console" />
      <SearchConsoleScreen queries={queries ?? EMPTY} pages={pages ?? EMPTY} />
    </>
  )
}
