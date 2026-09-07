import { t as defaultTranslate, type Translate } from '../strings'
import { LimitedIntelligenceBadge } from '../shell/LimitedIntelligenceBadge'
import {
  actionLabel,
  entityLabel,
  evidenceLine,
  formatDate,
  impactLabel,
  nextScanPrompt,
  signalLabel,
} from '../opportunities/list'
import { renderTemplatedLine } from '../opportunities/why'
import { ConnectSearchConsoleCard } from '../performance/ConnectSearchConsoleCard'
import { PerformanceChart } from '../performance/PerformanceChart'
import type { PerformanceOverview } from '../performance/types'
import type { ArticleSummary, CalendarResponse, CalendarTopic } from '../content/types'
import type { OpportunityListResponse, OpportunityRow } from '../opportunities/types'
import {
  attentionHref,
  attentionText,
  connectionLines,
  monthStrip,
  nextTopic,
  todayOutcome,
  todaysTopic,
  type AttentionResponse,
} from './dashboard'

/**
 * The dashboard once a store is set up: what to do, what is coming, what
 * happened, and what still needs the merchant.
 *
 * The order is the argument. Opportunities lead, content follows — this product
 * answers "what should I do about my store" before "what did you publish", and
 * a dashboard that led with an article count would be a content tool wearing a
 * growth tool's name.
 *
 * **Nothing on this page is a count against a target.** The month strip states
 * bare counts: articles published, topics held back. There is no "22 of 31", no
 * progress ring, no month-to-date pace. One article a day is a ceiling that the
 * quality bar is allowed to stop us reaching, and a number shown against a
 * denominator would turn that ceiling into a promise and every quiet day into a
 * shortfall.
 */

export interface DashboardScreenProps {
  readonly opportunities: OpportunityListResponse
  readonly calendar: CalendarResponse
  readonly articles: readonly ArticleSummary[]
  readonly performance: PerformanceOverview | null
  readonly attention: AttentionResponse
  readonly connections: {
    readonly shopify: string
    readonly searchConsole: string
    readonly lastScanAt: string | null
  }
  /** The day the page was drawn on, decided by the server rather than a browser clock. */
  readonly today: string
  readonly t?: Translate
}

export function DashboardScreen({
  opportunities,
  calendar,
  articles,
  performance,
  attention,
  connections,
  today,
  t = defaultTranslate,
}: DashboardScreenProps) {
  const next = nextTopic(calendar.topics, today)
  const current = todaysTopic(calendar.topics, today)
  const outcome = todayOutcome(current)
  const lines = monthStrip({ articles, calendar, month: today.slice(0, 7) }, t)

  return (
    <div className="sortiva-dash">
      <GrowthHeadline data={opportunities} today={today} t={t} />
      <NextUp next={next} today={current} outcome={outcome} t={t} />
      <MonthStrip lines={lines} t={t} />
      <PerformanceSnapshot performance={performance} t={t} />
      <AttentionList attention={attention} t={t} />
      <Connections connections={connections} t={t} />
    </div>
  )
}

// ── 1. Growth headline ──────────────────────────────────────────────────────

function GrowthHeadline({
  data,
  today,
  t,
}: {
  data: OpportunityListResponse
  today: string
  t: Translate
}) {
  const top = [...data.opportunities]
    .filter((row) => row.status === 'new' || row.status === 'accepted')
    .sort((left, right) => right.impactScore - left.impactScore)
    .slice(0, 3)

  return (
    <section className="sortiva-dash__card" data-dashboard-section="growth">
      <div className="sortiva-dash__headline">
        <h1>{t('appendixA.opportunityHeadline', { count: data.counts.open })}</h1>
        {data.limitedIntelligence ? <LimitedIntelligenceBadge t={t} compact /> : null}
      </div>

      <ul className="sortiva-dash__action-counts" data-dashboard-action-counts>
        {Object.entries(data.counts.byAction).map(([action, count]) => (
          <li key={action} data-dashboard-action={action}>
            <span>{actionLabel(action as OpportunityRow['recommendedAction'], t)}</span>
            <span className="sortiva-dash__count">{count}</span>
          </li>
        ))}
      </ul>

      <h2 className="sortiva-dash__subheading">{t('dashboard.growth.nextBest')}</h2>
      {top.length === 0 ? (
        <p className="sortiva-dash__note" data-dashboard-growth-empty>
          {nextScanPrompt('dashboard.growth.empty', data.nextScanAt, today, t)}
        </p>
      ) : (
        <ul className="sortiva-dash__next-best">
          {top.map((row) => (
            <CondensedOpportunity key={row.id} opportunity={row} t={t} />
          ))}
        </ul>
      )}

      <a className="sortiva-dash__link" href="/opportunities" data-dashboard-view-all>
        {t('dashboard.growth.viewAll')}
      </a>
    </section>
  )
}

/**
 * The opportunity card cut down to what fits on a dashboard: what kind of work
 * it is, what it is about, what it is worth, and the measured line underneath.
 * The words come from the same helpers the full card uses, so the two describe
 * the same opportunity in the same terms.
 */
function CondensedOpportunity({
  opportunity,
  t,
}: {
  opportunity: OpportunityRow
  t: Translate
}) {
  return (
    <li
      className="sortiva-dash__opp"
      data-dashboard-opportunity={opportunity.id}
      data-action={opportunity.recommendedAction}
    >
      <span className="sortiva-dash__badge" data-action={opportunity.recommendedAction}>
        {actionLabel(opportunity.recommendedAction, t)}
      </span>
      <span className="sortiva-dash__pill">{impactLabel(opportunity.impact, t)}</span>
      <p className="sortiva-dash__opp-title">{opportunity.entityRef.label}</p>
      <p className="sortiva-dash__opp-evidence">{evidenceLine(opportunity.evidence, t)}</p>
      <p className="sortiva-dash__opp-kind">{entityLabel(opportunity.entityRef.kind, t)}</p>
      <a href={`/opportunities#${opportunity.id}`}>{t('dashboard.growth.openOne')}</a>
    </li>
  )
}

// ── 2. Next up ──────────────────────────────────────────────────────────────

function NextUp({
  next,
  today,
  outcome,
  t,
}: {
  next: CalendarTopic | null
  today: CalendarTopic | null
  outcome: ReturnType<typeof todayOutcome>
  t: Translate
}) {
  return (
    <section className="sortiva-dash__card" data-dashboard-section="next_up">
      <h2>{t('dashboard.nextUp.heading')}</h2>

      {next ? (
        <div className="sortiva-dash__topic" data-dashboard-next-topic={next.id}>
          <p className="sortiva-dash__topic-title">{next.title}</p>
          <p className="sortiva-dash__topic-date">
            {t('dashboard.nextUp.scheduled', { date: formatDate(next.scheduledFor) })}
          </p>
          <p className="sortiva-dash__topic-why" data-dashboard-why>
            {renderTemplatedLine(next.why, t).text}
          </p>
          {next.opportunityId && next.signalType ? (
            <a
              className="sortiva-dash__chip"
              href={`/opportunities#${next.opportunityId}`}
              data-dashboard-topic-origin={next.signalType}
            >
              {t('dashboard.nextUp.from', { signal: signalLabel(next.signalType, t) })}
            </a>
          ) : null}
        </div>
      ) : (
        <p className="sortiva-dash__note" data-dashboard-next-empty>
          {t('dashboard.nextUp.none')}
        </p>
      )}

      {outcome === 'none' || !today ? null : (
        <div className="sortiva-dash__today" data-dashboard-today={outcome}>
          <h3>{t('dashboard.today.heading')}</h3>
          <p className="sortiva-dash__topic-title">{today.title}</p>
          {outcome === 'published' ? <p>{t('dashboard.today.published')}</p> : null}
          {outcome === 'in_review' ? <p>{t('dashboard.today.inReview')}</p> : null}
          {outcome === 'held' ? <p>{t('dashboard.today.held')}</p> : null}
          {today.articleId ? (
            <a href={`/content/articles/${today.articleId}`}>{t('dashboard.today.viewArticle')}</a>
          ) : null}
        </div>
      )}

      <a className="sortiva-dash__link" href="/content" data-dashboard-view-calendar>
        {t('dashboard.nextUp.viewCalendar')}
      </a>
    </section>
  )
}

// ── 3. The month strip ──────────────────────────────────────────────────────

/**
 * Counts, with nothing to measure them against.
 *
 * The cap line under the strip is one of the sentences the product may not
 * reword, and it is here for the same reason there are no denominators above
 * it: the merchant should read "up to one a day, quality permitting" beside the
 * count rather than infer a target from it.
 */
function MonthStrip({
  lines,
  t,
}: {
  lines: readonly { key: string; text: string; href?: string }[]
  t: Translate
}) {
  return (
    <section className="sortiva-dash__card" data-dashboard-section="month">
      <h2>{t('dashboard.month.heading')}</h2>
      <ul className="sortiva-dash__month" data-dashboard-month-strip>
        {lines.map((line) => (
          <li key={line.key} data-dashboard-month-line={line.key}>
            {line.href ? <a href={line.href}>{line.text}</a> : line.text}
          </li>
        ))}
      </ul>
      <p className="sortiva-dash__note" data-dashboard-cap-line>
        {t('appendixA.pricingCap')}
      </p>
      <p className="sortiva-dash__note">{t('dashboard.month.capNote')}</p>
    </section>
  )
}

// ── 4. Performance snapshot ─────────────────────────────────────────────────

function PerformanceSnapshot({
  performance,
  t,
}: {
  performance: PerformanceOverview | null
  t: Translate
}) {
  return (
    <section className="sortiva-dash__card" data-dashboard-section="performance">
      <h2>{t('dashboard.performance.heading')}</h2>
      {performance && performance.connected ? (
        <>
          <PerformanceChart
            series={performance.series}
            markers={performance.markers}
            t={t}
            box={{ width: 640, height: 64 }}
            compact
          />
          <a className="sortiva-dash__link" href="/performance" data-dashboard-view-performance>
            {t('dashboard.performance.viewAll')}
          </a>
        </>
      ) : (
        <ConnectSearchConsoleCard t={t} compact />
      )}
    </section>
  )
}

// ── 5. The attention list ───────────────────────────────────────────────────

/**
 * What is waiting on the merchant. A live query rather than a stored list, so a
 * row disappears the moment the thing it was about is dealt with and nothing
 * lingers after it stops being true.
 *
 * The stale-recommendation row is deliberately one quiet line among the others
 * rather than a warning: a recommendation nobody applied is a choice the
 * merchant is allowed to make.
 */
function AttentionList({ attention, t }: { attention: AttentionResponse; t: Translate }) {
  return (
    <section className="sortiva-dash__card" data-dashboard-section="attention">
      <h2>{t('dashboard.attention.heading')}</h2>
      {attention.items.length === 0 ? (
        <p className="sortiva-dash__note" data-dashboard-attention-empty>
          {t('dashboard.attention.empty')}
        </p>
      ) : (
        <ul className="sortiva-dash__attention">
          {attention.items.map((item) => (
            <li key={`${item.kind}-${item.since}`} data-dashboard-attention={item.kind}>
              <span>{attentionText(item.kind, t)}</span>
              <a href={attentionHref(item)}>{t('dashboard.attention.open')}</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ── 6. Connection health ────────────────────────────────────────────────────

function Connections({
  connections,
  t,
}: {
  connections: DashboardScreenProps['connections']
  t: Translate
}) {
  return (
    <section className="sortiva-dash__card" data-dashboard-section="connections">
      <h2>{t('dashboard.connections.heading')}</h2>
      <ul className="sortiva-dash__connections">
        {connectionLines(connections, t).map((line) => (
          <li
            key={line.key}
            data-dashboard-connection={line.key}
            data-dashboard-connection-healthy={line.healthy ? 'true' : 'false'}
          >
            {line.text}
          </li>
        ))}
      </ul>
      <a className="sortiva-dash__link" href="/settings/connections">
        {t('dashboard.connections.manage')}
      </a>
    </section>
  )
}
