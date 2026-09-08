import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rules } from '@sortiva/rules'
import type { QueryCluster } from '../contracts/opportunities'
import { coverageAnswerFor } from '../signals/testing'
import {
  MissingExistingTargetCheckError,
  assertClearedToCreate,
  isCreateClearance,
  type CreateClearance,
} from './clearance'
import { selectAction, type DetectedSignal } from './action-selection'
import { findExistingTarget } from './existing-target'
import type { ExistingTargetInput } from './ports'

/**
 * Nothing writes a new page without the check having run first, and this is the
 * half of that rule a review cannot forget.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

/** Every production source file in `packages/core`, tests excluded. */
function sourceFiles(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(full)
  }
  return out.sort()
}

const cluster: QueryCluster = {
  head: 'best trail running shoes',
  members: [],
  intentClass: 'buying_guide',
  familyIds: ['11111111-1111-4111-8111-111111111111'],
}

function input(overrides: Partial<ExistingTargetInput> = {}): ExistingTargetInput {
  return {
    cluster,
    rankedPages: [],
    pages: [],
    proxyRankings: [],
    limitedIntelligence: false,
    config: rules().defaults.gates.existing_target_check,
    fetchedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('clearance to write a new page', () => {
  it('is issued when the check found nothing to improve', () => {
    const { clearance } = findExistingTarget(input())

    expect(isCreateClearance(clearance)).toBe(true)
    expect(() => assertClearedToCreate(clearance, cluster.head)).not.toThrow()
  })

  it('is withheld when a page of ours already covers the intent', () => {
    const { clearance } = findExistingTarget(
      input({
        pages: [
          {
            url: 'https://shop.example/collections/trail-running',
            pageType: 'collection',
            intentClass: 'buying_guide',
            familyIds: cluster.familyIds,
            presence: 'unknown',
          },
        ],
      }),
    )

    expect(clearance).toBeNull()
    expect(() => assertClearedToCreate(clearance, cluster.head)).toThrow(
      MissingExistingTargetCheckError,
    )
  })

  it('cannot be forged by an object that merely looks like one', () => {
    const forged = {
      clusterHead: cluster.head,
      checkedAt: '2026-03-01T00:00:00.000Z',
      weakExistingTarget: null,
      linkTasks: [],
    } as unknown as CreateClearance

    expect(isCreateClearance(forged)).toBe(false)
    expect(() => assertClearedToCreate(forged, cluster.head)).toThrow(
      MissingExistingTargetCheckError,
    )
  })

  it('cannot be carried across from a different topic', () => {
    const { clearance } = findExistingTarget(input())

    expect(() => assertClearedToCreate(clearance, 'waterproof hiking boots')).toThrow(
      MissingExistingTargetCheckError,
    )
  })

  it('carries the link back to a page too weak to take the work over', () => {
    const { clearance } = findExistingTarget(
      input({
        rankedPages: [
          { url: 'https://shop.example/collections/trail-running', impressions: 900, position: 61 },
        ],
        pages: [
          {
            url: 'https://shop.example/collections/trail-running',
            pageType: 'collection',
            intentClass: null,
            familyIds: [],
            presence: 'unknown',
          },
        ],
      }),
    )

    expect(clearance?.linkTasks).toEqual([
      {
        existingUrl: 'https://shop.example/collections/trail-running',
        reasonTemplateKey: 'existing_target_weak_match_link',
      },
    ])
  })

  it('is minted in exactly one place, so no second route to a new page can open', () => {
    const importers = sourceFiles(join(HERE, '..')).filter((file) =>
      readFileSync(file, 'utf8').includes('mintCreateClearance'),
    )

    expect(importers.map((file) => relative(join(HERE, '..'), file).split(sep).join('/'))).toEqual([
      'opportunities/clearance.ts',
      'opportunities/existing-target.ts',
    ])
  })
})

/**
 * Every branch of action selection, as one fixture each.
 *
 * The map's keys are checked against the branches the code actually has, so a
 * signal added to the engine without a fixture here fails rather than slipping
 * past the rule below unexamined.
 */
const WINDOW = { startDate: '2026-02-01', endDate: '2026-02-28', days: 28 }
const EVIDENCE = [{ key: 'position', value: 5, source: 'gsc', fetchedAt: '2026-03-01T00:00:00.000Z' }]
const FAMILY = 'trail-running'

const SIGNAL_FIXTURES: Record<DetectedSignal['signalType'], DetectedSignal> = {
  striking_distance: {
    signalType: 'striking_distance',
    page: '/collections/a',
    pageType: 'collection',
    clusterHead: 'trail running shoes',
    position: 8,
    clusterImpressions: 900,
    clusterClicks: 10,
    pageImpressions: 900,
    storeMedianPageImpressions: 100,
    otherQualifyingClusters: 0,
    window: WINDOW,
    evidence: EVIDENCE,
  },
  low_ctr_at_strong_rank: {
    signalType: 'low_ctr_at_strong_rank',
    page: '/collections/a',
    pageType: 'collection',
    clusterHead: 'trail running shoes',
    position: 3,
    clusterImpressions: 900,
    clusterClicks: 5,
    observedCtr: 0.01,
    predictedCtr: 0.1,
    ctrRatio: 0.1,
    curveSource: 'standard',
    pageImpressions: 900,
    storeMedianPageImpressions: 100,
    brandedExcluded: false,
    otherQualifyingClusters: 0,
    window: WINDOW,
    evidence: EVIDENCE,
  },
  content_decay: {
    signalType: 'content_decay',
    page: '/blogs/guides/a',
    pageType: 'article_ours',
    currentClicks: 10,
    currentImpressions: 500,
    currentPosition: 14,
    baselineClicks: 100,
    baselineImpressions: 900,
    baselinePosition: 5,
    clicksRatio: 0.1,
    positionWorsenedBy: 9,
    storeMedianBaselineClicks: 20,
    consecutiveWeeklyEvaluations: 3,
    confirmed: true,
    window: WINDOW,
    baselineWindow: WINDOW,
    evidence: EVIDENCE,
  },
  cannibalization: {
    signalType: 'cannibalization',
    clusterHead: 'trail running shoes',
    clusterImpressions: 900,
    clusterClicks: 20,
    competing: [
      { page: '/a', pageType: 'collection', intentClass: 'buying_guide', clicks: 10, impressions: 450, impressionShare: 0.5, position: 7 },
      { page: '/b', pageType: 'collection', intentClass: 'buying_guide', clicks: 10, impressions: 450, impressionShare: 0.5, position: 9 },
    ],
    weeklyLeaders: [{ weekStart: '2026-02-01', page: '/a' }],
    leaderChanges: 2,
    baselineClusterClicks: 40,
    clicksVsBaselineRatio: 0.5,
    validation: { validated: true, intentClass: 'buying_guide', via: 'both' },
    window: WINDOW,
    evidence: EVIDENCE,
  },
  uncovered_commercial_query: {
    signalType: 'uncovered_commercial_query',
    keyword: 'best trail running shoes',
    intentClass: 'buying_guide',
    monthlySearchVolume: 900,
    familyIds: [FAMILY],
    source: 'merchant_seed',
    weakExistingTarget: null,
    clearance: coverageAnswerFor({ head: 'best trail running shoes', familyIds: [FAMILY] }).clearance,
    evidence: EVIDENCE,
  },
  competitor_coverage_gap: {
    signalType: 'competitor_coverage_gap',
    keyword: 'trail running shoes',
    monthlySearchVolume: 900,
    familyIds: [FAMILY],
    competitorsRanking: [
      { domain: 'rival-one.com', position: 3, url: 'https://rival-one.com/a' },
      { domain: 'rival-two.com', position: 7, url: 'https://rival-two.com/b' },
    ],
    ourPosition: null,
    ourRankingUrl: null,
    ourRankingPageType: null,
    existingTarget: coverageAnswerFor({ head: 'trail running shoes', familyIds: [FAMILY] }),
    evidence: EVIDENCE,
  },
  product_family_coverage_gap: {
    signalType: 'product_family_coverage_gap',
    familyId: FAMILY,
    familyName: 'Trail Running',
    isTopSeller: true,
    revenueShare: 0.3,
    keywordCandidatesClearingFloor: 5,
    unrankedPages: [],
    weakExistingTarget: null,
    clearance: coverageAnswerFor({ head: 'Trail Running', familyIds: [FAMILY] }).clearance,
    evidence: EVIDENCE,
  },
  catalog_richness_gap: {
    signalType: 'catalog_richness_gap',
    keyword: 'trail running shoes',
    intentClass: 'buying_guide',
    monthlySearchVolume: 900,
    familyIds: [FAMILY],
    distinctFacts: 2,
    contributingProducts: 1,
    shortfalls: [],
    evidence: EVIDENCE,
  },
  missing_or_weak_metadata: {
    signalType: 'missing_or_weak_metadata',
    page: '/collections/a',
    pageType: 'collection',
    missingFields: ['seo_title'],
    duplicateFields: [],
    sharedWith: [],
    evidence: EVIDENCE,
  },
  existing_page_intent_gap: {
    signalType: 'existing_page_intent_gap',
    page: '/collections/a',
    pageType: 'collection',
    clusterHead: 'trail running shoes',
    position: 9,
    clusterImpressions: 500,
    missingSubtopics: ['sizing'],
    evidence: EVIDENCE,
  },
  indexing_issue: {
    signalType: 'indexing_issue',
    page: '/collections/a',
    pageType: 'collection',
    reason: 'not_indexed',
    evidence: EVIDENCE,
  },
}

/** The signal types action selection actually has a branch for, read off the file rather than listed here. */
function branchesInActionSelection(): string[] {
  const source = readFileSync(join(HERE, 'action-selection.ts'), 'utf8')
  return [...source.matchAll(/case '([a-z_]+)':/g)].map((match) => match[1]!).sort()
}

/**
 * The clearance a caller who skipped the check would have: every field of a
 * real one that a person could see and write down, and none of the marker that
 * makes it real.
 *
 * Built field by field rather than by spreading a real one, because the marker
 * is a symbol and a spread copies symbols too — so a spread would produce a
 * *valid* clearance and this test would prove nothing.
 */
function forgedLike(clearance: unknown): unknown {
  if (!clearance || typeof clearance !== 'object') return { clusterHead: '', linkTasks: [] }
  return Object.fromEntries(Object.entries(clearance as Record<string, unknown>))
}

/** The same signal as it would arrive from a detector that never ran the check. */
function withoutRealClearance(signal: DetectedSignal): DetectedSignal {
  const copy = { ...signal } as Record<string, unknown>
  if ('clearance' in copy) copy['clearance'] = forgedLike(copy['clearance'])
  if ('existingTarget' in copy) {
    const existing = copy['existingTarget'] as Record<string, unknown>
    copy['existingTarget'] = { ...existing, clearance: forgedLike(existing['clearance']) }
  }
  return copy as unknown as DetectedSignal
}

describe('nothing proposes a new page without the check having run', () => {
  it('has a fixture for every branch action selection has, so a new signal cannot arrive unexamined', () => {
    expect(Object.keys(SIGNAL_FIXTURES).sort()).toEqual(branchesInActionSelection())
  })

  it('still has branches that propose a new page, or the rule below proves nothing', () => {
    const creating = Object.values(SIGNAL_FIXTURES).filter((signal) => selectAction(signal).action === 'CREATE')
    expect(creating.length).toBeGreaterThan(0)
  })

  it('refuses every new-page recommendation whose permission was not minted by the check', () => {
    for (const [signalType, signal] of Object.entries(SIGNAL_FIXTURES)) {
      if (selectAction(signal).action !== 'CREATE') continue
      expect(
        () => selectAction(withoutRealClearance(signal)),
        `${signalType} reached CREATE without a clearance the existing-target check minted`,
      ).toThrow(MissingExistingTargetCheckError)
    }
  })

  it('refuses a clearance obtained for a different subject', () => {
    for (const [signalType, signal] of Object.entries(SIGNAL_FIXTURES)) {
      if (selectAction(signal).action !== 'CREATE') continue
      const elsewhere = coverageAnswerFor({ head: 'something else entirely', familyIds: [FAMILY] })
      const copy = { ...signal } as Record<string, unknown>
      if ('clearance' in copy) copy['clearance'] = elsewhere.clearance
      if ('existingTarget' in copy) copy['existingTarget'] = elsewhere
      expect(
        () => selectAction(copy as unknown as DetectedSignal),
        `${signalType} accepted a clearance minted for another subject`,
      ).toThrow(MissingExistingTargetCheckError)
    }
  })
})
