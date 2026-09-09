import type { RulesLayer } from './types'

/**
 * Which of the product's numbers an operator can actually move for one store,
 * and which are read from the repo file wherever they are used.
 *
 * A row in `rules_overrides` only changes anything for code that asks for the
 * store's numbers rather than the file's. Most code does not yet, and the
 * failure that causes is silent: an operator sets a threshold, gets no error,
 * and the product goes on behaving exactly as before. This table is what the
 * operator command refuses against, so that failure becomes a refusal with a
 * sentence attached.
 *
 * **It is a hand-kept record of what the code does, not a switch that makes it
 * do anything.** Nothing reads this at runtime. Moving an entry to `honoured`
 * does not make a single reader honour anything; wiring the reader does, and
 * then the entry follows. The completeness test next door proves every number
 * in the config file is classified here, so a new group cannot arrive
 * unclassified — it cannot prove a classification is still true.
 */

/** How far a `rules_overrides` row aimed at one of these numbers actually reaches. */
export type RulesReach =
  /** Every path that reads this number resolves the store's rows first. */
  | 'honoured'
  /** Some paths resolve the store's rows and some read the repo file. */
  | 'partial'
  /** No path resolves the store's rows: a row here changes nothing at all. */
  | 'ignored'

export interface RulesReachEntry {
  /** A dotted path, matched as a prefix. The longest matching prefix wins. */
  readonly prefix: string
  readonly reach: RulesReach
  /** What happens if somebody sets it, in words an operator can act on. */
  readonly note: string
}

/**
 * Ordered by nothing in particular: lookup takes the longest matching prefix,
 * so a group's entry states the common case and the entries below it state the
 * exceptions.
 */
export const RULES_REACH: readonly RulesReachEntry[] = [
  // ── The signal thresholds: what counts as a search worth writing about ────
  {
    prefix: 'signals',
    reach: 'honoured',
    note: 'The weekly scan that detects work for a store folds that store’s rows before it measures anything.',
  },
  {
    prefix: 'signals.striking_distance.window_days',
    reach: 'partial',
    note: 'The weekly scan honours it. The passes that review a page the merchant already has (packages/jobs/src/optimize/pack.ts, packages/jobs/src/optimize/intent-gap-pass.ts) read the same window from the repo file, so moving it changes which searches raise new work but not how far back an existing page is measured.',
  },
  {
    prefix: 'signals.existing_page_intent_gap',
    reach: 'ignored',
    note: 'Everything that reads it — the daily shortlist of pages to analyse and the OPTIMIZE analysis and research pack (packages/jobs/src/scan/intent-gap.ts, packages/jobs/src/optimize/*) — takes it from the repo file.',
  },

  // ── Scoring: how a piece of work is ranked and how sure we say we are ─────
  {
    prefix: 'scoring',
    reach: 'honoured',
    note: 'The weekly scan, the refresh pool and the daily drift pass all fold the store’s rows before they score anything.',
  },
  {
    prefix: 'scoring.confidence',
    reach: 'partial',
    note: 'The weekly scan and the refresh pool honour it, so what is scored and stored moves. The opportunities and performance screens and the reader that lists accepted work (apps/web/app/api/opportunities, apps/web/app/api/performance, packages/jobs/src/scan/opportunity-source.ts) recompute a band from the repo file, so some of what a merchant sees will not move with it.',
  },
  {
    prefix: 'scoring.create.competitor_gap_source_bonus',
    reach: 'partial',
    note: 'The weekly scan honours it when it scores the work. The replenishment pass that decides which of that work gets a calendar day reads the same bonus from the repo file.',
  },

  // ── Gates: what we refuse to write, and what we refuse to publish ─────────
  {
    prefix: 'gates',
    reach: 'honoured',
    note: 'The topic-admission gate and the two draft gates resolve the store’s rows, and so does the weekly scan.',
  },
  {
    prefix: 'gates.substance_floor',
    reach: 'partial',
    note: 'The gates and the scan honour it. Catalogue distillation and family grouping (packages/jobs/src/ingestion/distill.ts, families.ts) and the products and profile screens read it from the repo file, so moving it changes what a gate refuses but not what those screens call thin.',
  },
  {
    prefix: 'gates.existing_target_check',
    reach: 'ignored',
    note: 'Only the check for a page the store already has reads it (packages/jobs/src/scan/existing-target.ts), from the repo file.',
  },
  {
    prefix: 'gates.draft_grading',
    reach: 'partial',
    note: 'The article gate honours it. The grader for an OPTIMIZE recommendation (apps/web/app/api/recommendations/_lib/config.ts) and the offline judge eval read the same floors from the repo file.',
  },
  {
    prefix: 'gates.optimize_recommendation',
    reach: 'ignored',
    note: 'Read only by the OPTIMIZE passes and the recommendations API, both from the repo file.',
  },

  // ── The learning loop and the calendar ────────────────────────────────────
  {
    prefix: 'learning',
    reach: 'ignored',
    note: 'The pass that fills the calendar (packages/jobs/src/generation/replenish.ts) reads these from the repo file.',
  },
  {
    prefix: 'learning.labels',
    reach: 'ignored',
    note: 'Nothing reads these yet — the pass that labels a published article against the store’s own median is not built, so a row here changes nothing anywhere.',
  },
  {
    prefix: 'learning.outcomes',
    reach: 'ignored',
    note: 'Read by the recommendations API when it books a measurement and by the job that makes it (packages/jobs/src/optimize/measure.ts), both from the repo file.',
  },
  {
    prefix: 'learning.patterns.multiplier_clamp_min',
    reach: 'partial',
    note: 'The weekly scan honours it when it scores work; the replenishment pass reads the same clamp from the repo file.',
  },
  {
    prefix: 'learning.patterns.multiplier_clamp_max',
    reach: 'partial',
    note: 'The weekly scan honours it when it scores work; the replenishment pass reads the same clamp from the repo file.',
  },
  {
    prefix: 'learning.refresh.position_min',
    reach: 'honoured',
    note: 'The refresh pool resolves the store’s rows before it judges a merchant’s request.',
  },
  {
    prefix: 'learning.refresh.position_max',
    reach: 'honoured',
    note: 'The refresh pool resolves the store’s rows before it judges a merchant’s request.',
  },
  {
    prefix: 'learning.refresh.cooldown_days',
    reach: 'honoured',
    note: 'The refresh pool resolves the store’s rows before it judges a merchant’s request.',
  },

  // ── Writing the article ──────────────────────────────────────────────────
  {
    prefix: 'generation',
    reach: 'honoured',
    note: 'The draft gates resolve the store’s rows before they measure a draft against these.',
  },
  {
    prefix: 'generation.cycle',
    reach: 'ignored',
    note: 'Read by the daily generation cycle and its scheduling (packages/jobs/src/generation/daily-cycle.ts, tasks.ts) from the repo file.',
  },

  // ── Everything read by a job that has no store in hand ────────────────────
  {
    prefix: 'budgets',
    reach: 'ignored',
    note: 'Read from the repo file by the OPTIMIZE passes, the intent-gap shortlist and the spend sweeps.',
  },
  {
    prefix: 'auto_trips',
    reach: 'ignored',
    note: 'Read from the repo file by the sweeps that trip a kill switch. These are how the product protects itself, and they are deliberately the same for every store.',
  },
  {
    prefix: 'discovery',
    reach: 'ignored',
    note: 'Read from the repo file by keyword discovery, catalogue enrichment, the profile screen and the research-pack cache.',
  },
  {
    prefix: 'search_console',
    reach: 'ignored',
    note: 'Read from the repo file by the Search Console sync and backfill and by everything that measures a window of search data.',
  },
  {
    prefix: 'clusters',
    reach: 'ignored',
    note: 'Read from the repo file by the nightly clustering pass and by everything that reads a cluster back.',
  },
  {
    prefix: 'ctr_curve',
    reach: 'ignored',
    note: 'Read from the repo file by the nightly pass that fits a store’s click curve.',
  },
]

/**
 * The entry governing one threshold path. The longest matching prefix wins, so
 * `gates.substance_floor.distinct_facts_min` takes the substance-floor entry
 * rather than the one for `gates`.
 *
 * Returns `undefined` only for a path no entry covers, which the completeness
 * test makes impossible for a key that names a real threshold. A caller that
 * gets `undefined` has been handed a key that is not in the config at all, and
 * `assertOverridableKey` is what refuses that.
 */
export function reachOf(key: string): RulesReachEntry | undefined {
  let best: RulesReachEntry | undefined
  for (const entry of RULES_REACH) {
    if (key !== entry.prefix && !key.startsWith(`${entry.prefix}.`)) continue
    if (!best || entry.prefix.length > best.prefix.length) best = entry
  }
  return best
}

/** Every dotted path to a single value in a layer — the paths a row may name. */
export function thresholdPaths(layer: RulesLayer): string[] {
  const out: string[] = []
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, path === '' ? key : `${path}.${key}`)
      }
      return
    }
    out.push(path)
  }
  walk(layer, '')
  return out
}
