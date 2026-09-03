import { describe, expect, it } from 'vitest'
import { rules } from '@sortiva/rules'
import { buildOpportunityDraft } from '../opportunities/build'
import { indexPages } from '../signals/types'
import type { ClusterDefinition, ClusterShareRow } from '../search'
import { groundSubtopics, type CoverageAnalysis, type CoverageCompetitorPage } from './coverage'
import { buildIntentGapSignal, shortlistIntentGapPages } from './intent-gap'

/**
 * Worked example 4 (main §7.8): "collection at #11; top SERPs all cover
 * waterproofing, terrain, fit, sizing; ours doesn't" → an OPTIMIZE on the page
 * that exists, with the missing subtopics as the evidence.
 */

const config = rules().defaults.signals.existing_page_intent_gap
const PAGE = 'https://shop.example/collections/hiking-boots'
const QUERY = 'waterproof hiking boots'

const pages = indexPages([
  { url: PAGE, pageType: 'collection', intentClass: null },
  { url: 'https://shop.example/collections/socks', pageType: 'collection', intentClass: null },
])

const clusters: ClusterDefinition[] = [
  { headQuery: QUERY, memberQueries: ['waterproof walking boots'], clusterId: 'c-boots' },
  { headQuery: 'wool socks', memberQueries: [], clusterId: 'c-socks' },
]

function share(over: Partial<ClusterShareRow> = {}): ClusterShareRow {
  return { page: PAGE, query: QUERY, clicks: 88, impressions: 5200, position: 11, ...over }
}

function competitor(url: string, position: number): CoverageCompetitorPage {
  return { url, domain: new URL(url).hostname, position, title: null, headings: [], excerpt: '' }
}

const COMPETITORS = [1, 2, 3, 4, 5].map((n) => competitor(`https://rival${n}.example/boots`, n))

/** The example's own four subtopics: on the pages above ours, absent from ours. */
function exampleAnalysis(): CoverageAnalysis {
  const covering = (count: number, heading: string) =>
    COMPETITORS.slice(0, count).map((c) => ({ url: c.url, heading }))
  return {
    subtopics: groundSubtopics(
      {
        subtopics: [
          { name: 'waterproofing', presentOnOurPage: false, ourEvidence: null, competitors: covering(5, 'Waterproofing') },
          { name: 'terrain', presentOnOurPage: false, ourEvidence: null, competitors: covering(4, 'Terrain') },
          { name: 'fit', presentOnOurPage: false, ourEvidence: null, competitors: covering(3, 'Fit') },
          { name: 'sizing', presentOnOurPage: false, ourEvidence: null, competitors: covering(3, 'Sizing') },
          { name: 'brand history', presentOnOurPage: false, ourEvidence: null, competitors: covering(1, 'About us') },
          { name: 'price', presentOnOurPage: true, ourEvidence: 'From £120', competitors: covering(5, 'Price') },
        ],
      },
      COMPETITORS,
    ),
    topPagesAnalysed: 5,
    modelId: 'claude-sonnet-5',
    promptVersion: 'intent-gap.v1',
    cacheHit: false,
    usdCost: 0.02,
  }
}

describe('shortlisting the pages worth paying to compare', () => {
  it('takes a page inside the band and leaves the rest alone', () => {
    const shortlist = shortlistIntentGapPages({
      clusters,
      rows: [
        share(),
        // Already at the top of the results: nothing here for a coverage
        // comparison to win.
        share({ page: 'https://shop.example/collections/socks', query: 'wool socks', position: 2, impressions: 900 }),
      ],
      pages,
      config,
      limit: 10,
    })

    expect(shortlist).toHaveLength(1)
    expect(shortlist[0]).toMatchObject({
      page: PAGE,
      pageType: 'collection',
      clusterHead: QUERY,
      position: 11,
      clusterImpressions: 5200,
      reason: 'gsc_position',
    })
  })

  it('drops a page beyond the band and one the inventory has never heard of', () => {
    const shortlist = shortlistIntentGapPages({
      clusters,
      rows: [
        share({ position: 34 }),
        share({ page: 'https://shop.example/collections/unknown', position: 9 }),
      ],
      pages,
      config,
      limit: 10,
    })

    expect(shortlist).toEqual([])
  })

  it('keeps one job per page, carrying the count of the other searches that also qualified', () => {
    const shortlist = shortlistIntentGapPages({
      clusters,
      rows: [share(), share({ query: 'waterproof walking boots', impressions: 400, position: 12 })],
      pages,
      config,
      limit: 10,
    })

    expect(shortlist).toHaveLength(1)
    expect(shortlist[0]!.clusterImpressions).toBe(5600)
  })

  it('admits a competitor-gap target whatever Search Console says about it', () => {
    const shortlist = shortlistIntentGapPages({
      clusters,
      rows: [],
      pages,
      config,
      competitorGapTargets: [
        { page: PAGE, clusterHead: 'hiking boots uk', position: 24, clusterImpressions: 120 },
      ],
      limit: 10,
    })

    expect(shortlist[0]).toMatchObject({ page: PAGE, reason: 'competitor_gap_target', position: 24 })
  })

  it('never exceeds the allowance it is handed, so one scan cannot spend a store\'s whole day of analyses', () => {
    const many = Array.from({ length: 9 }, (_, n) => `https://shop.example/collections/c${n}`)
    const shortlist = shortlistIntentGapPages({
      clusters: many.map((_, n) => ({ headQuery: `q${n}`, memberQueries: [] })),
      rows: many.map((page, n) => share({ page, query: `q${n}`, impressions: 1000 - n })),
      pages: indexPages(many.map((url) => ({ url, pageType: 'collection' as const, intentClass: null }))),
      config,
      limit: 3,
    })

    expect(shortlist).toHaveLength(3)
  })
})

describe('worked example 4 — the existing page intent gap', () => {
  const candidate = shortlistIntentGapPages({
    clusters,
    rows: [share()],
    pages,
    config,
    limit: 10,
  })[0]!

  const signal = buildIntentGapSignal({
    candidate,
    analysis: exampleAnalysis(),
    config,
    analysedAt: '2026-09-03T09:00:00.000Z',
  })!

  it('names the gap set the example describes, and nothing our page already covers', () => {
    expect(signal.missingSubtopics).toEqual(['waterproofing', 'terrain', 'fit', 'sizing'])
    expect(signal.page).toBe(PAGE)
    expect(signal.position).toBe(11)
  })

  it('carries per-subtopic evidence: the name, how many of the ranking pages settle it, and where', () => {
    const byKey = new Map(signal.evidence.map((fact) => [fact.key, fact]))

    expect(byKey.get('missing_subtopic_1')?.value).toBe('waterproofing')
    expect(byKey.get('missing_subtopic_1_top_page_count')?.value).toBe(5)
    expect(String(byKey.get('missing_subtopic_1_top_page_headings')?.value)).toContain(
      'https://rival1.example/boots — Waterproofing',
    )
    expect(byKey.get('missing_subtopic_4')?.value).toBe('sizing')
    expect(byKey.get('missing_subtopic_count')?.value).toBe(4)
    expect(byKey.get('top_pages_analysed')?.value).toBe(5)
  })

  it('says of each fact whether it was measured or read out of two documents by a model', () => {
    const byKey = new Map(signal.evidence.map((fact) => [fact.key, fact]))

    expect(byKey.get('position')?.source).toBe('gsc')
    expect(byKey.get('top_pages_analysed')?.source).toBe('dataforseo')
    expect(byKey.get('missing_subtopic_1')?.source).toBe('serp_coverage_analysis')
  })

  it('becomes an OPTIMIZE on the page that exists, never a competing new one', () => {
    const draft = buildOpportunityDraft(signal, {
      accountId: '11111111-1111-4111-8111-111111111111',
      limitedIntelligence: false,
      rulesVersion: rules().rulesVersion,
      winnability: rules().defaults.gates.winnability.limited_intelligence_constant,
      patternMultiplierClamp: {
        min: rules().defaults.learning.patterns.multiplier_clamp_min,
        max: rules().defaults.learning.patterns.multiplier_clamp_max,
      },
      detectedAt: '2026-09-03T09:00:00.000Z',
    }, rules().defaults.scoring)

    expect(draft.recommendedAction).toBe('OPTIMIZE')
    expect(draft.entityType).toBe('url')
    expect(draft.entityRef).toBe(PAGE)
  })
})

describe('when the comparison finds too little to act on', () => {
  it('produces nothing rather than a card with one thin line on it', () => {
    const analysis = exampleAnalysis()
    const thin: CoverageAnalysis = {
      ...analysis,
      subtopics: analysis.subtopics.filter((s) => s.name === 'waterproofing'),
    }

    const candidate = shortlistIntentGapPages({ clusters, rows: [share()], pages, config, limit: 10 })[0]!

    expect(buildIntentGapSignal({ candidate, analysis: thin, config, analysedAt: '2026-09-03T09:00:00.000Z' })).toBeNull()
  })
})
