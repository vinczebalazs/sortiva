import {
  dayOffset,
  generateSyntheticStore,
  type SyntheticGscRow,
  type SyntheticProduct,
  type SyntheticStore,
} from './syntheticStore'

/**
 * main §7.8's eight worked examples, as data.
 *
 * The spec calls them "acceptance fixtures — each becomes a unit test over a
 * synthetic store". This module is that synthetic store, one per example, with
 * the evidence the table states (positions, impressions, clicks, whether a
 * suitable URL exists, whether the catalog has substance) reproduced exactly.
 *
 * Deliberately **no expected opportunity or action is asserted here.** The
 * mapping from evidence to action is main §7.6's job and Lane C's card; a
 * fixture that also encoded the answer would let the implementation be written
 * to match the fixture rather than the spec. What each scenario carries is
 * `expectedAction` as *documentation of the spec's row*, for the test that will
 * later assert it — never as an input to detection.
 */

export type ExpectedAction = 'CREATE' | 'OPTIMIZE' | 'REFRESH' | 'FIX' | 'HOLD'

export interface SignalScenario {
  /** 1–8, matching the §7.8 table row. */
  readonly id: number
  readonly key: string
  readonly title: string
  /** The spec's own one-line evidence summary. */
  readonly evidence: string
  /** What §7.8 says the action should be. Assertion target, never a detection input. */
  readonly expectedAction: ExpectedAction | readonly ExpectedAction[]
  readonly store: SyntheticStore
  /** The page × query rows that carry this scenario's evidence, beyond the store's baseline. */
  readonly gsc: readonly SyntheticGscRow[]
  /** True when the store has no URL that could serve the query (scenario 3). */
  readonly hasSuitableUrl: boolean
  readonly notes: string
}

const BASE_DATE = '2026-01-01'

/** 28 days of one page × query pair, so a window-based signal has a window to read. */
function window28(
  page: string,
  query: string,
  totals: { impressions: number; clicks: number; position: number },
  startDate = BASE_DATE,
): SyntheticGscRow[] {
  const rows: SyntheticGscRow[] = []
  for (let day = 0; day < 28; day += 1) {
    rows.push({
      page,
      query,
      // Split evenly and give the remainder to the first day, so the 28-day
      // totals are exactly the numbers §7.8 states.
      impressions: Math.floor(totals.impressions / 28) + (day === 0 ? totals.impressions % 28 : 0),
      clicks: Math.floor(totals.clicks / 28) + (day === 0 ? totals.clicks % 28 : 0),
      position: totals.position,
      date: dayOffset(startDate, day),
    })
  }
  return rows
}

function storeWithSeed(seed: number, overrides = {}): SyntheticStore {
  return generateSyntheticStore({ seed, startDate: BASE_DATE, ...overrides })
}

/** A catalog whose products are all marketing copy — scenario 7's precondition. */
function fluffOnlyStore(seed: number): SyntheticStore {
  return generateSyntheticStore({
    seed,
    startDate: BASE_DATE,
    fluffShare: 1,
    families: { 'trail-running': 8 },
  })
}

/** Removes every page that could serve the query — scenario 3's precondition. */
function storeWithoutTrailCoverage(seed: number): SyntheticStore {
  const store = generateSyntheticStore({
    seed,
    startDate: BASE_DATE,
    families: { road_running: 10, hiking_boots: 8 },
  })
  return store
}

export function signalScenarios(): readonly SignalScenario[] {
  return [
    {
      id: 1,
      key: 'striking_distance',
      title: 'Striking Distance',
      evidence:
        'query "best trail running shoes", page /collections/trail-running, position 7.3, 9,402 impressions / 28d',
      expectedAction: 'OPTIMIZE',
      store: storeWithSeed(101),
      gsc: window28('/collections/trail-running', 'best trail running shoes', {
        impressions: 9402,
        clicks: 210,
        position: 7.3,
      }),
      hasSuitableUrl: true,
      notes: 'Google already deems the page relevant; the opportunity is on the page that exists.',
    },
    {
      id: 2,
      key: 'low_ctr_at_strong_rank',
      title: 'Strong rank, weak CTR',
      evidence: 'position 3.4, 15,000 impressions, 310 clicks; CTR below the store’s own curve',
      expectedAction: 'OPTIMIZE',
      store: storeWithSeed(102),
      gsc: window28('/collections/trail-running', 'trail running shoes', {
        impressions: 15000,
        clicks: 310,
        position: 3.4,
      }),
      hasSuitableUrl: true,
      notes:
        'The comparison is against the store’s own CTR curve, not an absolute rate (main §7.3).',
    },
    {
      id: 3,
      key: 'uncovered_commercial_query',
      title: 'Missing coverage',
      evidence: 'commercial query with volume; a matching family with substance; no suitable URL',
      expectedAction: 'CREATE',
      store: storeWithoutTrailCoverage(103),
      // No page ranks for it — the absence is the evidence.
      gsc: [],
      hasSuitableUrl: false,
      notes:
        'The existing-target check (main §7.7) must find nothing here; if it finds a page, this becomes OPTIMIZE.',
    },
    {
      id: 4,
      key: 'existing_page_intent_gap',
      title: 'Existing intent gap',
      evidence:
        'collection at #11; top SERPs all cover waterproofing, terrain, fit, sizing; ours does not',
      expectedAction: 'OPTIMIZE',
      store: storeWithSeed(104),
      gsc: window28('/collections/hiking-boots', 'waterproof hiking boots', {
        impressions: 5200,
        clicks: 88,
        position: 11,
      }),
      hasSuitableUrl: true,
      notes:
        'The missing subtopics are the evidence; the page is the right target, its coverage is not.',
    },
    {
      id: 5,
      key: 'cannibalization',
      title: 'Cannibalization',
      evidence: 'collection, blog post and product URL alternate for the same query',
      expectedAction: ['FIX', 'OPTIMIZE'],
      store: storeWithSeed(105),
      gsc: [
        ...window28('/collections/trail-running', 'trail running shoes', {
          impressions: 3000,
          clicks: 70,
          position: 8.2,
        }),
        ...window28('/blogs/guides/trail-running-shoes', 'trail running shoes', {
          impressions: 2400,
          clicks: 41,
          position: 9.6,
        }),
        ...window28('/products/trail-running-1', 'trail running shoes', {
          impressions: 1800,
          clicks: 30,
          position: 12.4,
        }),
      ],
      hasSuitableUrl: true,
      notes: 'Three of our URLs share one query; none is clearly the primary target.',
    },
    {
      id: 6,
      key: 'content_decay',
      title: 'Decay',
      evidence: 'position 3.8 → 7.1 over 3 months; clicks 1,700 → 860/mo',
      expectedAction: 'REFRESH',
      store: storeWithSeed(106),
      gsc: [
        // The comparison window, three months back.
        ...window28(
          '/blogs/guides/choosing-trail-shoes',
          'how to choose trail running shoes',
          { impressions: 22000, clicks: 1700, position: 3.8 },
          dayOffset(BASE_DATE, -84),
        ),
        // The current window.
        ...window28('/blogs/guides/choosing-trail-shoes', 'how to choose trail running shoes', {
          impressions: 19000,
          clicks: 860,
          position: 7.1,
        }),
      ],
      hasSuitableUrl: true,
      notes: 'A previously proven asset losing performance — two windows, not one.',
    },
    {
      id: 7,
      key: 'catalog_richness_gap',
      title: 'Catalog richness gap',
      evidence: 'good commercial keyword; the mapped products carry marketing fluff only',
      expectedAction: 'HOLD',
      store: fluffOnlyStore(107),
      gsc: window28('/collections/trail-running', 'best trail running shoes', {
        impressions: 6100,
        clicks: 120,
        position: 9.1,
      }),
      hasSuitableUrl: true,
      notes:
        'Everything except substance is present. The store must fail main §8.2’s substance floor, or the fixture proves nothing.',
    },
    {
      id: 8,
      key: 'indexing_issue',
      title: 'Index issue (P1)',
      evidence: 'an important collection is not indexed, or its canonical points elsewhere',
      expectedAction: 'FIX',
      store: storeWithSeed(108),
      // Impressions collapse to nothing because the page is not in the index.
      gsc: window28('/collections/hiking-boots', 'hiking boots', {
        impressions: 0,
        clicks: 0,
        position: 0,
      }),
      hasSuitableUrl: true,
      notes:
        'Content cannot compete while the technical block exists; the signal is the absence of impressions on a page that should have them.',
    },
  ]
}

export function scenario(id: number): SignalScenario {
  const found = signalScenarios().find((s) => s.id === id)
  if (!found) throw new Error(`No §7.8 scenario ${id}; the spec defines 1–8.`)
  return found
}

/** Every product across a scenario's store, for substance checks. */
export function scenarioProducts(id: number): readonly SyntheticProduct[] {
  return scenario(id).store.products
}
