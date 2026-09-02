import {
  DashboardScreen,
  type ArticlesResponse,
  type CalendarResponse,
  type OpportunityListResponse,
  type PerformanceOverview,
  type ShellAccount,
} from '@sortiva/ui'
import { getJson, type RequestContext } from '../_lib/api'

/**
 * The dashboard a merchant sees once their store is set up.
 *
 * Five reads, asked for together rather than in sequence: the page has no read
 * that depends on another, and a dashboard that took five round trips end to
 * end would be the slowest screen in the product.
 *
 * Every one of them may fail on its own without taking the page with it. A
 * dashboard is six independent answers, and losing one of them should cost the
 * merchant that section, not the page — so each read falls back to the empty
 * shape its section knows how to draw.
 *
 * "Today" is the server's day, as it is on the calendar. The day that actually
 * matters is the one in the store audience's timezone, which the settings
 * response knows and this does not yet ask for; the same correction fixes both
 * screens and is journalled rather than half-applied here.
 */

const NO_OPPORTUNITIES: OpportunityListResponse = {
  opportunities: [],
  counts: { open: 0, byAction: {} },
  lastScanAt: null,
  nextScanAt: null,
  limitedIntelligence: false,
  cursor: null,
}

const NO_CALENDAR: CalendarResponse = {
  topics: [],
  paused: { active: false, reason: null },
  nextReplenishmentAt: null,
}

interface AttentionResponse {
  readonly items: readonly {
    readonly kind:
      | 'draft_awaiting_review'
      | 'repair_pending'
      | 'export_url_unconfirmed'
      | 'merchant_task'
      | 'optimize_unapplied'
    readonly refs: Readonly<Record<string, string>>
    readonly since: string
  }[]
}

/** Six weeks around today, which is as much of the plan as the dashboard reasons about. */
function calendarRange(today: string): string {
  const from = new Date(`${today}T00:00:00.000Z`)
  from.setUTCDate(from.getUTCDate() - 21)
  const to = new Date(`${today}T00:00:00.000Z`)
  to.setUTCDate(to.getUTCDate() + 21)
  return `from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}`
}

export async function SteadyState({
  request,
  account,
}: {
  request: RequestContext
  account: ShellAccount
}) {
  const today = new Date().toISOString().slice(0, 10)

  const [opportunities, calendar, articles, performance, attention] = await Promise.all([
    getJson<OpportunityListResponse>('/api/opportunities', request),
    getJson<CalendarResponse>(`/api/calendar?${calendarRange(today)}`, request),
    getJson<ArticlesResponse>('/api/articles', request),
    getJson<PerformanceOverview>('/api/performance/overview', request),
    getJson<AttentionResponse>('/api/attention', request),
  ])

  return (
    <DashboardScreen
      opportunities={opportunities ?? NO_OPPORTUNITIES}
      calendar={calendar ?? NO_CALENDAR}
      articles={articles?.articles ?? []}
      performance={performance}
      attention={attention ?? { items: [] }}
      connections={account.connections}
      today={today}
    />
  )
}
