import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { fixtureOpportunities } from '@sortiva/core'
import type { ArticleSummary, CalendarResponse, CalendarTopic } from '../content/types'
import type { OpportunityListResponse, OpportunityRow } from '../opportunities/types'
import type { PerformanceOverview } from '../performance/types'
import { DashboardScreen } from './DashboardScreen'
import {
  attentionHref,
  connectionLines,
  DASHBOARD_SECTIONS,
  monthStrip,
  nextTopic,
  todayOutcome,
  todaysTopic,
  topOpportunities,
  type AttentionResponse,
} from './dashboard'

/**
 * What this file holds the dashboard to.
 *
 * The order of the six sections is the product's argument — opportunities
 * first, content second — so it is asserted against the rendered page rather
 * than trusted to whoever edits the JSX next.
 *
 * And nothing rendered anywhere on the page may read as a count against a
 * target. The catalogue already has a check that no *sentence* contains one;
 * this one reads the finished markup, because a denominator can also be
 * assembled at render time out of two values that are innocent apart.
 */

const TODAY = '2026-08-14'

const topic = (over: Partial<CalendarTopic> = {}): CalendarTopic => ({
  id: 'topic-1',
  title: 'Best wide-fit trail running shoes',
  scheduledFor: '2026-08-20',
  state: 'planned',
  intentClass: 'buying_guide',
  kind: 'new',
  source: 'auto',
  pinned: false,
  targetKeyword: 'wide fit trail running shoes',
  monthlySearchVolume: 1900,
  why: { templateKey: 'uncovered_commercial_query.no_suitable_url', params: { volume: 1900 } },
  opportunityId: '33333333-3333-4333-8333-333333333333',
  signalType: 'uncovered_commercial_query',
  articleId: null,
  rejection: null,
  ...over,
})

const article = (over: Partial<ArticleSummary> = {}): ArticleSummary => ({
  id: 'article-1',
  title: 'Fell shoe drop explained',
  state: 'published',
  delivery: 'export',
  publishedAt: '2026-08-04T09:00:00.000Z',
  publishedUrl: 'https://example.com/blogs/guides/drop',
  publishedViaOverride: false,
  repaired: false,
  refreshedCount: 0,
  performance: null,
  ...over,
})

const OPPORTUNITIES: OpportunityListResponse = {
  opportunities: fixtureOpportunities.map(
    (source, index) =>
      ({
        id: source.id,
        signalType: source.signalType,
        entityRef: source.entityRef,
        recommendedAction: source.recommendedAction,
        status: 'new',
        impact: source.impact,
        impactScore: 10 - index,
        confidence: source.confidence,
        confidenceScore: source.confidenceScore,
        confidenceFactors: [],
        evidence: source.evidence,
        why: { templateKey: source.reasonTemplateKey, params: source.reasonParams },
        preconditions: [],
        rulesVersion: source.rulesVersion,
        limitedIntelligence: source.limitedIntelligence,
        detectedAt: source.detectedAt,
        scheduledFor: null,
        expiresAt: null,
      }) as OpportunityRow,
  ),
  counts: { open: 23, byAction: { CREATE: 9, OPTIMIZE: 7, REFRESH: 4, FIX: 2, HOLD: 1 } },
  lastScanAt: '2026-08-10T04:10:00.000Z',
  nextScanAt: '2026-08-17T04:10:00.000Z',
  limitedIntelligence: false,
  cursor: null,
}

const CALENDAR: CalendarResponse = {
  topics: [
    topic(),
    topic({ id: 'topic-today', scheduledFor: TODAY, state: 'published', articleId: 'article-1' }),
    topic({ id: 'topic-held', scheduledFor: '2026-08-09', state: 'rejected_by_gate' }),
  ],
  paused: { active: false, reason: null },
  nextReplenishmentAt: '2026-09-01',
}

const PERFORMANCE: PerformanceOverview = {
  connected: true,
  series: [
    { date: '2026-08-12', clicks: 40, impressions: 1800 },
    { date: '2026-08-13', clicks: null, impressions: null },
    { date: '2026-08-14', clicks: 44, impressions: 1900 },
  ],
  markers: [{ date: '2026-08-12', kind: 'article_published', label: 'an article' }],
  results: [],
}

const ATTENTION: AttentionResponse = {
  items: [
    {
      kind: 'merchant_task',
      refs: { opportunityId: '44444444-4444-4444-8444-444444444444' },
      since: '2026-08-10T00:00:00.000Z',
    },
    {
      kind: 'export_url_unconfirmed',
      refs: { articleId: 'article-1' },
      since: '2026-08-08T00:00:00.000Z',
    },
  ],
}

const CONNECTIONS = { shopify: 'read', searchConsole: 'connected', lastScanAt: '2026-08-10T04:10:00.000Z' }

function render(over: Partial<Parameters<typeof DashboardScreen>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(DashboardScreen, {
      opportunities: OPPORTUNITIES,
      calendar: CALENDAR,
      articles: [article(), article({ id: 'article-2', publishedAt: '2026-08-11T09:00:00.000Z' })],
      performance: PERFORMANCE,
      attention: ATTENTION,
      connections: CONNECTIONS,
      today: TODAY,
      ...over,
    }),
  )
}

describe('the order of the page is the argument it makes', () => {
  it('lists the six sections in the order the product decided', () => {
    const html = render()
    const order = [...html.matchAll(/data-dashboard-section="([a-z_]+)"/g)].map((match) => match[1])
    expect(order).toEqual([...DASHBOARD_SECTIONS])
  })

  it('puts opportunities above anything about content', () => {
    const html = render()
    expect(html.indexOf('data-dashboard-section="growth"')).toBeLessThan(
      html.indexOf('data-dashboard-section="next_up"'),
    )
  })
})

/**
 * The denominator check, read off the finished page rather than off the
 * catalogue.
 *
 * "3 of 30" invites a merchant to treat the 30 as owed. The daily cap is a
 * ceiling the quality bar is allowed to stop us reaching, so a page that showed
 * progress against it would be promising something the product refuses to
 * promise. Every rendered form of that promise is banned here: "22 of 31",
 * "22/31", "22 out of 31", and a percentage.
 */
describe('no denominator survives to the rendered page', () => {
  const DENOMINATORS = [
    // "22 of 31", "22 out of 31"
    /\d[\d,]*\s*(?:of|out of)\s+\d/i,
    // "22/31"
    /\d[\d,]*\s*\/\s*\d/,
    // "71%" — a share is a denominator with the second number hidden
    /\d[\d,]*\s*%/,
    // A number sitting next to the idea of a target, in either order. The words
    // themselves are allowed — the product says "a ceiling, not a target" on
    // this very page — but a figure beside one of them is the promise being made.
    /\b(?:target|quota|goal)\b[^.!?]{0,24}\d/i,
    /\d[^.!?]{0,24}\b(?:target|quota|goal)\b/i,
  ]

  function text(html: string): string {
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
  }

  it('holds for the whole dashboard', () => {
    const rendered = text(render())
    for (const pattern of DENOMINATORS) {
      expect(pattern.test(rendered), `${pattern} matched: ${rendered.match(pattern)?.[0]}`).toBe(
        false,
      )
    }
  })

  it('holds for the month strip on its own, whatever the counts are', () => {
    const html = render({
      articles: Array.from({ length: 22 }, (_, index) =>
        article({ id: `article-${index}`, publishedAt: `2026-08-${String(index + 1).padStart(2, '0')}T09:00:00.000Z` }),
      ),
    })
    const strip = html.slice(
      html.indexOf('data-dashboard-section="month"'),
      html.indexOf('data-dashboard-section="performance"'),
    )
    const rendered = text(strip)
    expect(rendered).toContain('Articles published: 22')
    for (const pattern of DENOMINATORS) {
      expect(pattern.test(rendered), `${pattern} matched: ${rendered.match(pattern)?.[0]}`).toBe(
        false,
      )
    }
  })

  it('states the cap as a ceiling beside the counts', () => {
    const html = render()
    expect(html).toContain('data-dashboard-cap-line')
    expect(html).toContain('Up to 1 article per day, quality permitting')
  })

  it('draws no progress bar or ring anywhere on the strip', () => {
    const html = render()
    const strip = html.slice(
      html.indexOf('data-dashboard-section="month"'),
      html.indexOf('data-dashboard-section="performance"'),
    )
    expect(strip).not.toContain('<progress')
    expect(strip).not.toContain('role="progressbar"')
  })
})

describe('the growth headline', () => {
  it('leads with the canonical sentence and the count of what is open', () => {
    const html = render()
    expect(html).toContain('We found 23 ways to grow your store organically')
  })

  it('shows the three highest-scoring open opportunities, best first', () => {
    const top = topOpportunities(OPPORTUNITIES.opportunities)
    expect(top).toHaveLength(3)
    expect(top[0]!.impactScore).toBeGreaterThanOrEqual(top[1]!.impactScore)
  })

  it('carries counts by action with no target beside any of them', () => {
    const html = render()
    expect(html).toContain('data-dashboard-action="CREATE"')
    expect(html).toContain('data-dashboard-action="HOLD"')
  })
})

describe('next up, and what today came to', () => {
  it('picks the earliest planned day after today, never one that has passed', () => {
    expect(nextTopic(CALENDAR.topics, TODAY)?.id).toBe('topic-1')
  })

  it('reads today separately, and says what became of it', () => {
    const current = todaysTopic(CALENDAR.topics, TODAY)
    expect(current?.id).toBe('topic-today')
    expect(todayOutcome(current)).toBe('published')
  })

  it('treats a day with nothing scheduled as a normal day rather than a miss', () => {
    expect(todayOutcome(null)).toBe('none')
    const html = render({ calendar: { ...CALENDAR, topics: [topic()] } })
    expect(html).not.toContain('data-dashboard-today=')
  })

  it('renders the topic’s why-line from the catalogue rather than as sent text', () => {
    const html = render()
    expect(html).toContain('data-dashboard-why')
    // The template key never reaches the screen; the sentence does.
    expect(html).not.toContain('uncovered_commercial_query.no_suitable_url')
  })
})

describe('the month strip carries only what can be counted honestly', () => {
  it('counts articles published in the month in view', () => {
    const lines = monthStrip({
      articles: [article(), article({ id: 'a2', publishedAt: '2026-07-30T09:00:00.000Z' })],
      calendar: CALENDAR,
      month: '2026-08',
    })
    expect(lines.find((line) => line.key === 'published')?.text).toBe('Articles published: 1')
  })

  it('counts topics the quality bar held back, and links to them', () => {
    const lines = monthStrip({ articles: [], calendar: CALENDAR, month: '2026-08' })
    const held = lines.find((line) => line.key === 'held')
    expect(held?.text).toBe('Topics held by the quality bar: 1')
    expect(held?.href).toBe('/content')
  })

  it('names the next replenishment date as a date', () => {
    const lines = monthStrip({ articles: [], calendar: CALENDAR, month: '2026-08' })
    expect(lines.find((line) => line.key === 'replenishment')?.text).toContain('1 Sept 2026')
  })
})

describe('the performance snapshot', () => {
  it('draws the compact chart when Search Console is connected', () => {
    expect(render()).toContain('data-perf-chart="drawn"')
  })

  it('shows the canonical connect card instead when it is not', () => {
    const html = render({ performance: { ...PERFORMANCE, connected: false } })
    expect(html).toContain('Connect Google Search Console to unlock full Growth Intelligence')
    expect(html).not.toContain('data-perf-chart="drawn"')
  })

  it('shows the same card when the performance read failed altogether', () => {
    const html = render({ performance: null })
    expect(html).toContain('data-perf-connect')
  })
})

describe('the attention list', () => {
  it('sends each item to the surface that can resolve it', () => {
    expect(attentionHref(ATTENTION.items[0]!)).toBe('/products')
    expect(attentionHref(ATTENTION.items[1]!)).toBe('/content/articles/article-1')
  })

  it('renders one line per item, each with a way in', () => {
    const html = render()
    expect(html).toContain('data-dashboard-attention="merchant_task"')
    expect(html).toContain('data-dashboard-attention="export_url_unconfirmed"')
  })

  it('says so plainly when nothing needs the merchant', () => {
    expect(render({ attention: { items: [] } })).toContain('data-dashboard-attention-empty')
  })
})

describe('the connection row', () => {
  it('marks a broken connection unhealthy and a read-only Shopify grant healthy', () => {
    const lines = connectionLines({ ...CONNECTIONS, shopify: 'read' })
    expect(lines.find((line) => line.key === 'shopify')?.healthy).toBe(true)

    const broken = connectionLines({ ...CONNECTIONS, searchConsole: 'broken' })
    expect(broken.find((line) => line.key === 'searchConsole')?.healthy).toBe(false)
  })

  it('says no scan has run rather than showing an empty date', () => {
    const lines = connectionLines({ ...CONNECTIONS, lastScanAt: null })
    expect(lines.find((line) => line.key === 'lastScan')?.text).toBe('No scan yet')
  })
})
