import { t as defaultTranslate, type StringKey, type Translate } from '../strings'
import { formatDate } from '../opportunities/list'
import type { ArticleSummary, CalendarResponse, CalendarTopic } from '../content/types'
import type { OpportunityRow } from '../opportunities/types'

/**
 * What the steady-state dashboard decides before anything is drawn.
 *
 * The section order is the product's argument, so it is a constant here rather
 * than the order somebody happened to type the JSX in: opportunities first,
 * content second. The dashboard answers "what should I do" before "what got
 * published", and a test asserts the rendered page still comes out in this
 * order.
 *
 * The month strip is the other thing worth reading twice. **Every figure on it
 * is a bare count with nothing to compare it to.** One article a day is a
 * ceiling the quality bar may stop us reaching, never a quota, so a strip
 * reading "22 of 31" would promise a number the product refuses to promise —
 * and a merchant who saw 22 against 31 would reasonably conclude nine articles
 * were owed to them.
 */

export const DASHBOARD_SECTIONS = [
  'growth',
  'next_up',
  'month',
  'performance',
  'attention',
  'connections',
] as const

export type DashboardSection = (typeof DASHBOARD_SECTIONS)[number]

// ── The growth headline ─────────────────────────────────────────────────────

/**
 * The three opportunities worth putting on the dashboard: the highest-scoring
 * open ones. Ordered by the engine's own impact score rather than by the band,
 * because three "high" cards in an arbitrary order teaches the merchant nothing
 * about which to do first.
 */
export function topOpportunities(
  opportunities: readonly OpportunityRow[],
  limit = 3,
): readonly OpportunityRow[] {
  return [...opportunities]
    .filter((row) => row.status === 'new' || row.status === 'accepted')
    .sort((left, right) => right.impactScore - left.impactScore)
    .slice(0, limit)
}

// ── Next up, and what happened today ────────────────────────────────────────

/**
 * The next topic due to be written, which is the earliest planned one on or
 * after today. Deliberately not "the next topic in the array": the calendar is
 * returned in whatever order the API found it in, and a topic in the past is not
 * next.
 */
export function nextTopic(
  topics: readonly CalendarTopic[],
  today: string,
): CalendarTopic | null {
  const upcoming = topics
    .filter((topic) => topic.scheduledFor > today && topic.state === 'planned')
    .sort((left, right) => left.scheduledFor.localeCompare(right.scheduledFor))
  return upcoming[0] ?? null
}

/** Today's topic, whatever became of it. Null on a day with nothing scheduled — a normal day. */
export function todaysTopic(
  topics: readonly CalendarTopic[],
  today: string,
): CalendarTopic | null {
  return topics.find((topic) => topic.scheduledFor === today) ?? null
}

export type TodayOutcome = 'published' | 'in_review' | 'held' | 'pending' | 'none'

/**
 * What today's slot came to.
 *
 * `none` and `pending` are different and both are fine: a day with no topic is a
 * quiet day, which is normal and never made up for later, and a topic still to
 * run has simply not run yet.
 */
export function todayOutcome(topic: CalendarTopic | null): TodayOutcome {
  if (!topic) return 'none'
  if (topic.state === 'published') return 'published'
  if (topic.state === 'in_review') return 'in_review'
  if (topic.state === 'rejected_by_gate') return 'held'
  return 'pending'
}

// ── The month strip ─────────────────────────────────────────────────────────

/**
 * One line of the month strip: a count and the words around it.
 *
 * There is no `target` field on this type, and there is not going to be one.
 */
export interface MonthLine {
  readonly key: string
  readonly text: string
  /** Where the count leads, when it leads anywhere. */
  readonly href?: string
}

export interface MonthStripInput {
  readonly articles: readonly ArticleSummary[]
  readonly calendar: CalendarResponse
  /** The month in view, as `YYYY-MM`. */
  readonly month: string
}

function inMonth(iso: string | null, month: string): boolean {
  return iso !== null && iso.slice(0, 7) === month
}

/**
 * The month strip, built from the responses that exist.
 *
 * **Three of the six lines the design asks for are not built**, because nothing
 * in the API answers them: how many page-improvement recommendations were
 * generated this month, how many of those were marked applied, and how many
 * repairs ran. The opportunities response carries open counts rather than
 * monthly activity, and an article says only whether it was ever repaired, not
 * when. Showing a wrong number would be worse than showing fewer, so the strip
 * carries what can be counted honestly and the gap is written into the screen
 * contract for whoever builds the endpoint.
 */
export function monthStrip(
  input: MonthStripInput,
  t: Translate = defaultTranslate,
): readonly MonthLine[] {
  const published = input.articles.filter(
    (article) => article.state === 'published' && inMonth(article.publishedAt, input.month),
  ).length

  const held = input.calendar.topics.filter(
    (topic) => topic.state === 'rejected_by_gate' && topic.scheduledFor.slice(0, 7) === input.month,
  ).length

  const lines: MonthLine[] = [
    { key: 'published', text: t('dashboard.month.articlesPublished', { count: published }) },
  ]

  if (held > 0) {
    lines.push({
      key: 'held',
      text: t('dashboard.month.topicsHeld', { count: held }),
      href: '/content',
    })
  }

  if (input.calendar.nextReplenishmentAt) {
    lines.push({
      key: 'replenishment',
      text: t('dashboard.month.nextReplenishment', {
        date: formatDate(input.calendar.nextReplenishmentAt),
      }),
    })
  }

  return lines
}

// ── The attention list ──────────────────────────────────────────────────────

export type AttentionKind =
  | 'draft_awaiting_review'
  | 'repair_pending'
  | 'export_url_unconfirmed'
  | 'merchant_task'
  | 'optimize_unapplied'

/**
 * The names this screen may look for, spelt out rather than left as any
 * string. A misspelling here used to be a link that quietly went to the wrong
 * page for every merchant; now it does not compile.
 */
export interface AttentionRefs {
  readonly article_id?: string
  readonly opportunity_id?: string
  readonly task_id?: string
  readonly recommendation_id?: string
}

export interface AttentionItem {
  readonly kind: AttentionKind
  readonly refs: AttentionRefs
  readonly since: string
}

export interface AttentionResponse {
  readonly items: readonly AttentionItem[]
}

const ATTENTION_STRINGS: Readonly<Record<AttentionKind, StringKey>> = {
  draft_awaiting_review: 'attention.draftAwaitingReview' as StringKey,
  repair_pending: 'attention.repairPending' as StringKey,
  export_url_unconfirmed: 'attention.exportUrlUnconfirmed' as StringKey,
  merchant_task: 'attention.merchantTask' as StringKey,
  optimize_unapplied: 'attention.optimizeUnapplied' as StringKey,
}

export function attentionText(kind: AttentionKind, t: Translate = defaultTranslate): string {
  const key = ATTENTION_STRINGS[kind]
  return key ? t(key) : kind
}

/**
 * Where an attention item leads.
 *
 * The references an item carries decide this, not its kind: an unconfirmed
 * export URL is fixed on the article it belongs to, and a merchant task on the
 * Products page where the missing fields are listed. An item whose reference we
 * do not recognise still renders, pointing at the surface that owns its kind, so
 * a new reference name never makes a row disappear.
 */
export function attentionHref(item: AttentionItem): string {
  // Underscored, because that is what the endpoint sends and now what the
  // contract declares. Reading the other spelling matched nothing, so every
  // item fell through to the surface that owns its kind — which is why this
  // failed quietly instead of breaking.
  if (item.refs.article_id) return `/content/articles/${item.refs.article_id}`
  if (item.kind === 'merchant_task') return '/products'
  if (item.refs.opportunity_id) return `/opportunities#${item.refs.opportunity_id}`
  if (item.kind === 'draft_awaiting_review') return '/content/articles'
  return '/content'
}

// ── The connection row ──────────────────────────────────────────────────────

export interface ConnectionLine {
  readonly key: 'shopify' | 'searchConsole' | 'lastScan'
  readonly text: string
  readonly healthy: boolean
}

/**
 * What is connected and what is not, in one line each.
 *
 * A broken connection is the one thing on this row that stops the pipeline, so
 * it is marked unhealthy; a read-only Shopify grant is not — it is the default
 * and the product works entirely without write access.
 */
export function connectionLines(
  connections: {
    readonly shopify: string
    readonly searchConsole: string
    readonly lastScanAt: string | null
  },
  t: Translate = defaultTranslate,
): readonly ConnectionLine[] {
  const shopifyKey =
    connections.shopify === 'write'
      ? 'dashboard.connections.shopify.write'
      : connections.shopify === 'broken'
        ? 'dashboard.connections.shopify.broken'
        : connections.shopify === 'none'
          ? 'dashboard.connections.shopify.none'
          : 'dashboard.connections.shopify.read'

  const searchConsoleKey =
    connections.searchConsole === 'connected'
      ? 'dashboard.connections.searchConsole.connected'
      : connections.searchConsole === 'broken'
        ? 'dashboard.connections.searchConsole.broken'
        : 'dashboard.connections.searchConsole.limited'

  return [
    {
      key: 'shopify',
      text: t(shopifyKey as StringKey),
      healthy: connections.shopify !== 'broken' && connections.shopify !== 'none',
    },
    {
      key: 'searchConsole',
      text: t(searchConsoleKey as StringKey),
      healthy: connections.searchConsole === 'connected',
    },
    {
      key: 'lastScan',
      text: connections.lastScanAt
        ? t('dashboard.connections.lastScan', { date: formatDate(connections.lastScanAt) })
        : t('dashboard.connections.neverScanned'),
      healthy: connections.lastScanAt !== null,
    },
  ]
}
