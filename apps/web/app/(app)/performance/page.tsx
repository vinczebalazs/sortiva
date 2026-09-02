import { PerformanceScreen, type PerformanceOverview } from '@sortiva/ui'
import '@sortiva/ui/styles/content.css'
import '@sortiva/ui/styles/opportunities.css'
import '@sortiva/ui/styles/performance.css'
import { getJson, requestContext } from '../_lib/api'
import { PerformanceTabs } from './_lib/nav'

/**
 * Performance — the search chart, and what happened to each thing we published
 * or improved.
 *
 * Everything is drawn on the server: the chart is geometry over a fixed list of
 * days and the table is a list of rows, so there is nothing here that needs a
 * browser to decide it. Only the Search Console tab next door has a control
 * that changes what is read.
 *
 * A read that failed renders the not-connected card rather than an error page.
 * That is deliberately the same screen a store without Search Console sees: in
 * both cases we have no search data to show, and the connect card is the only
 * useful thing to put in that space.
 */

export const dynamic = 'force-dynamic'

const EMPTY: PerformanceOverview = {
  connected: false,
  series: [],
  markers: [],
  results: [],
}

export default async function PerformancePage() {
  const data =
    (await getJson<PerformanceOverview>('/api/performance/overview', await requestContext())) ??
    EMPTY

  return (
    <>
      <PerformanceTabs current="overview" />
      <PerformanceScreen data={data} />
    </>
  )
}
