import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RecordingUiAnalytics } from '../analytics'
import { t } from '../strings'
import { OpportunityCard } from './OpportunityCard'
import { OpportunityList } from './OpportunityList'
import {
  DEFAULT_FILTERS,
  GSC_DEPENDENT_SIGNALS,
  daysUntilScan,
  evidenceLine,
  groupByAction,
  matchesFilters,
  primaryAction,
  scanLine,
  signalTypesIn,
  sortOpportunities,
  toggleFilter,
} from './list'
import type { OpportunityListResponse, OpportunityRow } from './types'
import { catalogKeyFor, renderTemplatedLine } from './why'

/**
 * React escapes apostrophes and quotes on the way out, so the markup never
 * contains the sentence a merchant reads. These assertions are about the words,
 * so the entities are turned back into characters first.
 */
const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element)
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .replaceAll('&#x2F;', '/')

const AT = '2026-02-02T09:00:00.000Z'

const optimize: OpportunityRow = {
  id: '22222222-2222-4222-8222-222222222222',
  signalType: 'striking_distance',
  entityRef: { kind: 'page', id: '/collections/trail-running', label: 'Collection: Trail running shoes' },
  recommendedAction: 'OPTIMIZE',
  status: 'new',
  impact: 'high',
  impactScore: 78,
  confidence: 'high',
  confidenceScore: 84,
  confidenceFactors: [
    { label: 'Search Console data', direction: 'up' },
    { label: 'Limited intelligence', direction: 'down' },
  ],
  evidence: [
    { key: 'impressions', value: 8400, source: 'gsc', window: '28d', fetchedAt: AT },
    { key: 'average_position', value: 8.6, source: 'gsc', window: '28d', fetchedAt: AT },
    { key: 'matching_products', value: 14, source: 'catalog', fetchedAt: AT },
  ],
  why: { templateKey: 'striking_distance.page_one_intent_mismatch', params: {} },
  preconditions: [],
  rulesVersion: 'a'.repeat(64),
  limitedIntelligence: false,
  detectedAt: AT,
  scheduledFor: null,
  expiresAt: null,
}

const create: OpportunityRow = {
  ...optimize,
  id: '33333333-3333-4333-8333-333333333333',
  signalType: 'uncovered_commercial_query',
  entityRef: { kind: 'query_cluster', id: 'wide-feet', label: '"trail running shoes for wide feet"' },
  recommendedAction: 'CREATE',
  status: 'accepted',
  impact: 'medium',
  impactScore: 64,
  confidence: 'medium',
  confidenceScore: 55,
  why: { templateKey: 'uncovered_commercial_query.no_suitable_url', params: { volume: 880 } },
}

const hold: OpportunityRow = {
  ...optimize,
  id: '44444444-4444-4444-8444-444444444444',
  signalType: 'catalog_richness_gap',
  entityRef: { kind: 'family', id: 'trail-running', label: 'Family: Trail running shoes' },
  recommendedAction: 'HOLD',
  status: 'blocked',
  impact: 'low',
  impactScore: 20,
  preconditions: [
    {
      code: 'missing_product_details',
      whatToDo: { templateKey: 'precondition.missing_product_details', params: { products: 6 } },
    },
  ],
  why: { templateKey: 'catalog_richness_gap.insufficient_substance', params: { products: 6 } },
}

const refresh: OpportunityRow = {
  ...optimize,
  id: '55555555-5555-4555-8555-555555555555',
  signalType: 'content_decay',
  entityRef: { kind: 'article', id: 'grip', label: 'Our article: Grip explained' },
  recommendedAction: 'REFRESH',
  status: 'scheduled',
  scheduledFor: '2026-02-18',
}

const fix: OpportunityRow = {
  ...optimize,
  id: '66666666-6666-4666-8666-666666666666',
  signalType: 'cannibalization',
  recommendedAction: 'FIX',
  status: 'new',
}

function response(rows: readonly OpportunityRow[], extra: Partial<OpportunityListResponse> = {}): OpportunityListResponse {
  return {
    opportunities: rows,
    counts: { open: rows.length, byAction: { CREATE: 1, OPTIMIZE: 1, HOLD: 1 } },
    lastScanAt: AT,
    nextScanAt: '2026-02-09T06:00:00.000Z',
    limitedIntelligence: false,
    cursor: null,
    ...extra,
  }
}

// ── The card ─────────────────────────────────────────────────────────────────

describe('an opportunity card', () => {
  const html = render(createElement(OpportunityCard, { opportunity: optimize }))

  it('leads with the action badge', () => {
    expect(html).toContain('data-opp-badge="OPTIMIZE"')
    expect(html).toContain(t('opportunities.action.OPTIMIZE'))
  })

  it('shows impact and confidence as bands', () => {
    expect(html).toContain('data-opp-impact="high"')
    expect(html).toContain(t('opportunities.impact.high'))
    expect(html).toContain('data-opp-confidence="high"')
    expect(html).toContain(t('opportunities.confidence.high'))
  })

  it('names the entity it is about', () => {
    expect(html).toContain('Collection: Trail running shoes')
  })

  it('carries the numbers with their source and window', () => {
    expect(html).toContain('8,400 impressions')
    expect(html).toContain('avg. position 8.6')
    expect(html).toContain('14 matching products')
    expect(html).toContain('Search Console, last 28 days')
  })

  it('renders the why-line from the catalogue, not from a model', () => {
    expect(html).toContain(t('template.striking_distance.page_one_intent_mismatch'))
    expect(html).toContain('data-why-known="true"')
  })

  it('tags the signal that produced it', () => {
    expect(html).toContain('data-opp-signal="striking_distance"')
    expect(html).toContain(t('opportunities.signal.striking_distance'))
  })

  it('shows how the confidence number was reached', () => {
    expect(html).toContain(t('opportunities.confidenceHeading'))
    expect(html).toContain('data-confidence-direction="up"')
    expect(html).toContain('data-confidence-direction="down"')
  })
})

describe('the one button on a card, by action type', () => {
  const cases: readonly [OpportunityRow, string, string][] = [
    [create, 'schedule', t('opportunities.primary.schedule')],
    [optimize, 'generate', t('opportunities.primary.generate')],
    [refresh, 'on_calendar', t('opportunities.primary.onCalendar', { date: '18 Feb 2026' })],
    [fix, 'view_recommendation', t('opportunities.primary.viewRecommendation')],
    [hold, 'see_what_to_add', t('opportunities.primary.seeWhatToAdd')],
  ]

  for (const [row, kind, label] of cases) {
    it(`offers "${label}" for ${row.recommendedAction}`, () => {
      const action = primaryAction(row)
      expect(action?.kind).toBe(kind)
      expect(action?.label).toBe(label)
      expect(render(createElement(OpportunityCard, { opportunity: row }))).toContain(
        `data-opp-action="${kind}"`,
      )
    })
  }

  it('turns a scheduled CREATE into a link to the day rather than a second Schedule button', () => {
    const scheduled = { ...create, status: 'scheduled' as const, scheduledFor: '2026-02-14' }
    expect(primaryAction(scheduled)?.href).toBe('/content')
  })

  it('refuses to generate again once the day’s allowance is gone, and says so without a number we cannot check', () => {
    const html = render(
      createElement(OpportunityCard, { opportunity: optimize, context: { capReached: true } }),
    )
    expect(html).toContain(t('opportunities.optimizeCap'))
    expect(html).toContain('disabled')
  })
})

describe('a blocked card', () => {
  const html = render(createElement(OpportunityCard, { opportunity: hold }))

  it('says what is in the way and what to do about it', () => {
    expect(html).toContain('data-opp-precondition="missing_product_details"')
    expect(html).toContain(t('opportunities.precondition.missing_product_details'))
    expect(html).toContain(t('template.precondition.missing_product_details', { products: 6 }))
  })
})

describe('a card with no wording for its signal yet', () => {
  it('spells the code out rather than showing nothing', () => {
    const unknown = { ...optimize, signalType: 'some_future_signal' }
    expect(render(createElement(OpportunityCard, { opportunity: unknown }))).toContain(
      'Some future signal',
    )
  })

  it('admits a missing why-line instead of printing the key', () => {
    const line = renderTemplatedLine({ templateKey: 'nothing.here', params: {} })
    expect(line.known).toBe(false)
    expect(line.text).toBe(t('opportunities.whyUnavailable'))
    expect(line.text).not.toContain('nothing.here')
  })
})

describe('the existing-page why-line', () => {
  it('points at the canonical sentence rather than holding a second copy of it', () => {
    expect(catalogKeyFor('existing_target.prefer_optimize')).toBe('appendixA.existingPageWhyLine')
    expect(renderTemplatedLine({ templateKey: 'existing_target.prefer_optimize', params: {} }).text).toBe(
      'You already rank for this. Improving the existing collection is safer than creating another page.',
    )
  })
})

// ── Filters, sorting and grouping ────────────────────────────────────────────

describe('the filters', () => {
  const rows = [optimize, create, hold, refresh, fix]

  it('opens on what is still to be decided, and leaves history out', () => {
    const open = rows.filter((row) => matchesFilters(row, DEFAULT_FILTERS))
    expect(open.map((row) => row.id)).toEqual([optimize.id, create.id, hold.id, fix.id])
  })

  it('treats an untouched facet as no opinion rather than nothing', () => {
    const none = { ...DEFAULT_FILTERS, status: [] }
    expect(rows.filter((row) => matchesFilters(row, none))).toHaveLength(rows.length)
  })

  it('narrows to one action when its chip is on', () => {
    const only = toggleFilter({ ...DEFAULT_FILTERS, status: [] }, 'action', 'HOLD')
    expect(rows.filter((row) => matchesFilters(row, only))).toEqual([hold])
  })

  it('lets a chip be clicked off again', () => {
    const on = toggleFilter(DEFAULT_FILTERS, 'impact', 'high')
    expect(toggleFilter(on, 'impact', 'high').impact).toEqual([])
  })

  it('offers only the signal types actually present', () => {
    expect(signalTypesIn(rows)).toEqual([
      'cannibalization',
      'catalog_richness_gap',
      'content_decay',
      'striking_distance',
      'uncovered_commercial_query',
    ])
  })
})

describe('sorting', () => {
  it('puts impact first, then the score inside the band', () => {
    const order = sortOpportunities([hold, create, optimize], 'impact').map((row) => row.id)
    expect(order).toEqual([optimize.id, create.id, hold.id])
  })

  it('separates two cards in the same confidence band by the score behind it', () => {
    const lower = { ...optimize, id: 'b'.repeat(8), confidenceScore: 71 }
    expect(sortOpportunities([lower, optimize], 'confidence')[0]?.id).toBe(optimize.id)
  })

  it('is stable for two rows the engine scored identically', () => {
    const twin = { ...optimize, id: '00000000-0000-4000-8000-000000000000' }
    expect(sortOpportunities([optimize, twin], 'impact')[0]?.id).toBe(twin.id)
    expect(sortOpportunities([twin, optimize], 'impact')[0]?.id).toBe(twin.id)
  })
})

describe('group by action', () => {
  it('keeps the five sections in their fixed order whatever order the rows arrive in', () => {
    const groups = groupByAction([hold, fix, refresh, optimize, create])
    expect(groups.map((group) => group.action)).toEqual([
      'CREATE',
      'OPTIMIZE',
      'REFRESH',
      'FIX',
      'HOLD',
    ])
  })

  it('drops an action with nothing in it rather than showing an empty column', () => {
    expect(groupByAction([create]).map((group) => group.action)).toEqual(['CREATE'])
  })
})

// ── The list around them ─────────────────────────────────────────────────────

describe('the list', () => {
  const html = render(createElement(OpportunityList, { data: response([optimize, create, hold]) }))

  it('offers all five filter facets and the two controls', () => {
    for (const facet of ['action', 'impact', 'status', 'entity', 'signal']) {
      expect(html).toContain(`data-facet="${facet}"`)
    }
    expect(html).toContain('data-group-toggle="action"')
    expect(html).toContain(t('opportunities.sort.impact'))
  })

  it('counts each action without ever putting it over a target', () => {
    expect(html).toContain('>1</span>')
    expect(html).not.toMatch(/\d+\s+of\s+\d+/)
  })

  it('says when the store was last looked at and when it will be again', () => {
    expect(html).toContain(t('opportunities.scanLine', { date: '2 Feb 2026', next: '9 Feb 2026' }))
  })

  it('renders each card once', () => {
    expect([...html.matchAll(/data-opportunity-id="/g)]).toHaveLength(3)
  })

  it('draws the sections in the fixed order when grouping is on', () => {
    const grouped = render(
      createElement(OpportunityList, { data: response([hold, optimize, create]), initialGrouped: true }),
    )
    const order = [...grouped.matchAll(/data-opportunity-group="(\w+)"/g)].map((match) => match[1])
    expect(order).toEqual(['CREATE', 'OPTIMIZE', 'HOLD'])
  })
})

describe('the empty list', () => {
  /** The screen with nothing open on it, drawn on `today`. */
  const empty = (today: string, nextScanAt: string | null = '2026-02-09T06:00:00.000Z') =>
    render(createElement(OpportunityList, { data: response([], { nextScanAt }), today }))

  it('says how many days until the next scan, and never that there is nothing to do', () => {
    const html = empty('2026-02-02')
    expect(html).toContain('data-opportunities-empty="none"')
    expect(html).toContain('No open opportunities right now — the next scan runs in 7 days')
    expect(html).toContain(t('opportunities.emptyNote'))
    expect(html.toLowerCase()).not.toContain('nothing to do')
  })

  /**
   * The interval is counted to the same date the header prints, so the two
   * lines cannot say different things about the same scan. Both read the
   * timestamp as a UTC date.
   */
  it('counts to the date the header names, one line above it', () => {
    const html = empty('2026-02-02')
    expect(html).toContain(t('opportunities.scanLine', { date: '2 Feb 2026', next: '9 Feb 2026' }))
    expect(html).toContain('runs in 7 days')
  })

  it('says tomorrow rather than "in 1 days"', () => {
    expect(empty('2026-02-08')).toContain(
      'No open opportunities right now — the next scan runs tomorrow',
    )
  })

  it('says today when the scan is due later the same day', () => {
    expect(empty('2026-02-09')).toContain(
      'No open opportunities right now — the next scan runs today',
    )
  })

  /**
   * With no next-scan date the sentence stops rather than guessing a cadence —
   * which is what the live API sends today, so this is the form a merchant
   * currently reads. The note underneath still says the calendar is running.
   */
  it('promises no timing at all when it has no date to count to', () => {
    const html = empty('2026-02-02', null)
    expect(html).toContain('No open opportunities right now')
    expect(html).not.toContain('the next scan runs')
    expect(html).toContain(t('opportunities.emptyNote'))
  })

  it('promises no timing when the scan we know about has already gone by', () => {
    const html = empty('2026-02-15')
    expect(html).not.toContain('the next scan runs')
  })

  it('never names a weekday, whichever day the scan falls on', () => {
    for (const today of ['2026-02-02', '2026-02-08', '2026-02-09', '2026-02-15']) {
      expect(empty(today)).not.toMatch(/\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b/)
    }
  })

  it('distinguishes "you filtered everything out" from "there is nothing"', () => {
    const html = render(
      createElement(OpportunityList, {
        data: response([optimize]),
        initialFilters: { ...DEFAULT_FILTERS, action: ['HOLD'] },
      }),
    )
    expect(html).toContain('data-opportunities-empty="filtered"')
    expect(html).toContain(t('opportunities.clearFilters'))
  })
})

describe('counting the days to the next scan', () => {
  it('counts calendar days, not 24-hour blocks, so a scan later today is nought days away', () => {
    expect(daysUntilScan('2026-02-09T23:00:00.000Z', '2026-02-09')).toBe(0)
    expect(daysUntilScan('2026-02-10T00:30:00.000Z', '2026-02-09')).toBe(1)
  })

  it('accepts a bare date as well as a timestamp', () => {
    expect(daysUntilScan('2026-02-16', '2026-02-09')).toBe(7)
  })

  it('refuses to answer for a scan that has gone by, or for no scan, or for nonsense', () => {
    expect(daysUntilScan('2026-02-08T23:59:00.000Z', '2026-02-09')).toBeNull()
    expect(daysUntilScan(null, '2026-02-09')).toBeNull()
    expect(daysUntilScan('not a date', '2026-02-09')).toBeNull()
  })
})

describe('limited intelligence', () => {
  it('names the checks that are not running, and leaves the badge to the header', () => {
    const html = render(
      createElement(OpportunityList, { data: response([optimize], { limitedIntelligence: true }) }),
    )
    expect(html).toContain('data-limited-signals="true"')
    for (const signal of GSC_DEPENDENT_SIGNALS) {
      expect(html).toContain(`data-unavailable-signal="${signal}"`)
    }
    // The badge itself belongs to the activation header above this list; a
    // second one would tell the merchant the same thing twice.
    expect(html).not.toContain('data-testid="limited-intelligence-badge"')
  })

  it('marks a proxy-ranked opportunity as estimated on the card', () => {
    const proxied = { ...optimize, limitedIntelligence: true }
    expect(render(createElement(OpportunityCard, { opportunity: proxied }))).toContain(
      t('opportunities.estimatedRanking'),
    )
  })
})

describe('the evidence line', () => {
  it('stops at three facts, because a card is scanned rather than studied', () => {
    const many = [...optimize.evidence, { key: 'clicks', value: 310, source: 'gsc', fetchedAt: AT }]
    expect(evidenceLine(many)?.split(' · ')).toHaveLength(4)
  })

  it('is nothing at all when there is no evidence, rather than an empty flourish', () => {
    expect(evidenceLine([])).toBeNull()
  })
})

describe('what this screen may report', () => {
  /**
   * The card's title is the merchant's own collection name and the why-line is
   * a sentence about their store. Neither may leave the browser for the
   * analytics vendor, and the guard is the event property table rather than
   * anyone's care at the call site.
   */
  it('cannot attach an opportunity title or a why-line to any of its events', () => {
    const recorder = new RecordingUiAnalytics()

    recorder.capture('opportunity_viewed', {
      opportunity_id: optimize.id,
      signal_type: optimize.signalType,
      recommended_action: optimize.recommendedAction,
      // Neither of these is a declared property of the event, and neither is
      // expressible as any kind the table has.
      title: optimize.entityRef.label,
      why: t('template.striking_distance.page_one_intent_mismatch'),
    } as never)

    expect(recorder.events[0]?.properties).toEqual({
      opportunity_id: optimize.id,
      signal_type: 'striking_distance',
      recommended_action: 'OPTIMIZE',
    })
    expect(recorder.rejected.map((entry) => entry.key)).toEqual(['title', 'why'])
  })

  it('reports the button pressed as a name, never as its words', () => {
    const recorder = new RecordingUiAnalytics()
    const action = primaryAction(optimize)
    recorder.capture('opportunity_action_clicked', {
      opportunity_id: optimize.id,
      action: action?.kind ?? 'none',
    })
    expect(recorder.events[0]?.properties.action).toBe('generate')
    expect(recorder.rejected).toEqual([])
  })
})

describe('the scan line', () => {
  it('says only what it knows', () => {
    expect(scanLine(null, '2026-02-09T06:00:00.000Z')).toBe(
      t('opportunities.scanLineFirst', { next: '9 Feb 2026' }),
    )
    expect(scanLine(null, null)).toBeNull()
  })
})
