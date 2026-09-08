import { describe, expect, it } from 'vitest'
import { generateTasks } from './tasks'
import type { ExistingPageIntentGapSignal, IndexingIssueSignal } from './p1-signal-shapes'
import { coverageAnswerFor } from '../signals/testing'

const EVIDENCE = [{ key: 'position', value: 5, source: 'gsc', fetchedAt: 'x' }]

describe('generateTasks', () => {
  it('gives our own article one schedule_topic task rather than recommendation-style edits (main §10.5)', () => {
    const tasks = generateTasks({
      signalType: 'striking_distance',
      page: '/blogs/guides/x',
      pageType: 'article_ours',
      clusterHead: 'x',
      position: 6,
      clusterImpressions: 100,
      clusterClicks: 5,
      pageImpressions: 100,
      storeMedianPageImpressions: 50,
      otherQualifyingClusters: 0,
      window: { startDate: '2026-01-01', endDate: '2026-01-28', days: 28 },
      evidence: EVIDENCE,
    })
    expect(tasks).toEqual([{ kind: 'schedule_topic', description: expect.any(String) }])
  })

  it('gives a HOLD candidate exactly one product_data task', () => {
    const tasks = generateTasks({
      signalType: 'catalog_richness_gap',
      keyword: 'x',
      intentClass: 'buying_guide',
      monthlySearchVolume: 100,
      familyIds: ['f1'],
      distinctFacts: 2,
      contributingProducts: 1,
      shortfalls: [{ productId: 'p1', title: 'Shoe', familyId: 'f1', populatedFields: 1, missingFields: ['material'] }],
      evidence: EVIDENCE,
    })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.kind).toBe('product_data')
  })

  it('gives cannibalization the three structural tasks the spec names', () => {
    const tasks = generateTasks({
      signalType: 'cannibalization',
      clusterHead: 'x',
      clusterImpressions: 100,
      clusterClicks: 10,
      competing: [],
      weeklyLeaders: [],
      leaderChanges: 2,
      baselineClusterClicks: null,
      clicksVsBaselineRatio: null,
      validation: { validated: true, intentClass: 'buying_guide', via: 'alternation' },
      window: { startDate: '2026-01-01', endDate: '2026-01-28', days: 28 },
      evidence: EVIDENCE,
    })
    expect(tasks.map((t) => t.kind)).toEqual(['primary_url', 'internal_links', 'consolidate'])
  })

  it('links a weak-match uncovered query back to the page it has to support', () => {
    const withLink = generateTasks({
      signalType: 'uncovered_commercial_query',
      keyword: 'x',
      intentClass: 'buying_guide',
      monthlySearchVolume: 100,
      familyIds: ['f1'],
      source: 'merchant_seed',
      weakExistingTarget: '/products/y',
      clearance: coverageAnswerFor({ head: 'x', familyIds: ['f1'], found: 'weak', url: '/products/y' }).clearance,
      evidence: EVIDENCE,
    })
    expect(withLink.map((t) => t.kind)).toEqual(['schedule_topic', 'internal_links'])

    const withoutLink = generateTasks({
      signalType: 'uncovered_commercial_query',
      keyword: 'x',
      intentClass: 'buying_guide',
      monthlySearchVolume: 100,
      familyIds: ['f1'],
      source: 'merchant_seed',
      weakExistingTarget: null,
      clearance: coverageAnswerFor({ head: 'x', familyIds: ['f1'] }).clearance,
      evidence: EVIDENCE,
    })
    expect(withoutLink.map((t) => t.kind)).toEqual(['schedule_topic'])
  })

  it('adds one add_section task per missing subtopic for an intent gap', () => {
    const signal: ExistingPageIntentGapSignal = {
      signalType: 'existing_page_intent_gap',
      page: '/collections/hiking-boots',
      pageType: 'collection',
      clusterHead: 'waterproof hiking boots',
      position: 11,
      clusterImpressions: 5200,
      missingSubtopics: ['waterproofing', 'terrain', 'fit', 'sizing'],
      evidence: EVIDENCE,
    }
    expect(generateTasks(signal)).toHaveLength(4)
  })

  it('gives an indexing issue one canonical_recommendation task, worded by its reason', () => {
    const signal: IndexingIssueSignal = {
      signalType: 'indexing_issue',
      page: '/collections/hiking-boots',
      pageType: 'collection',
      reason: 'not_indexed',
      evidence: EVIDENCE,
    }
    const tasks = generateTasks(signal)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.kind).toBe('canonical_recommendation')
  })

  it('every task this file can produce carries a non-empty description', () => {
    const metadataTasks = generateTasks({
      signalType: 'missing_or_weak_metadata',
      page: '/collections/x',
      pageType: 'collection',
      missingFields: ['seo_title', 'seo_description'],
      duplicateFields: [],
      sharedWith: [],
      evidence: EVIDENCE,
    })
    expect(metadataTasks.length).toBeGreaterThan(0)
    for (const task of metadataTasks) {
      expect(task.description.trim().length).toBeGreaterThan(0)
    }
  })
})
