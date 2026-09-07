import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { RulesConfigError, configPath, loadRulesConfig } from './load'
import { SIGNAL_TYPES } from './types'

/**
 * T0.2 done-when: "a test enumerates the spec's named thresholds and asserts
 * each key exists; invalid YAML fails startup; `rules_version` changes when any
 * value changes; snapshot of the loaded config committed."
 *
 * The enumeration below is the spec read back as a checklist. Each row is a
 * dotted path into a resolved layer plus the section it comes from. A threshold
 * the spec names that is missing from `signals.config.yaml` fails here — which
 * is the only mechanism that catches "the number was left as a literal in Lane
 * C's code" before Lane C writes it.
 */

const NAMED_THRESHOLDS: ReadonlyArray<readonly [path: string, spec: string]> = [
  // ── Signal detection ───────────────────────────────────────────────────────
  ['signals.striking_distance.position_min', 'main §7.3 — position band 4–15'],
  ['signals.striking_distance.position_max', 'main §7.3 — position band 4–15'],
  ['signals.striking_distance.window_days', 'main §7.3 — trailing 28d'],
  ['signals.striking_distance.impressions_store_median_multiple_min', 'main §7.3 — impressions ≥ store median for rated pages'],
  ['signals.low_ctr_at_strong_rank.position_max', 'main §7.3 — position ≤ 5'],
  ['signals.low_ctr_at_strong_rank.impressions_store_median_multiple_min', 'main §7.3 — impressions ≥ 2× store median'],
  ['signals.low_ctr_at_strong_rank.observed_vs_predicted_ctr_ratio_max', 'main §7.3 — CTR < 0.6× predicted'],
  ['signals.content_decay.clicks_ratio_max', 'main §7.3 — clicks ≤ 0.6×'],
  ['signals.content_decay.position_worsened_min', 'main §7.3 — position worsened ≥ 3'],
  ['signals.content_decay.comparison_window_offset_weeks', 'main §7.3 — vs 12 weeks earlier'],
  ['signals.content_decay.consecutive_weekly_evaluations_min', 'main §7.3 — holds across ≥ 2 weekly evaluations'],
  ['signals.content_decay.baseline_clicks_store_median_multiple_min', 'main §7.3 — baseline clicks ≥ store median'],
  ['signals.cannibalization.competing_urls_min', 'main §7.3 — ≥ 2 store URLs'],
  ['signals.cannibalization.impression_share_min', 'main §7.3 — each ≥ 20% of cluster impressions'],
  ['signals.cannibalization.position_max', 'main §7.3 — both within position ≤ 30'],
  ['signals.cannibalization.leader_changes_min', 'main §7.3 — validation: the leading URL flips week-over-week'],
  ['signals.cannibalization.baseline_offset_weeks', 'main §7.3 — validation: vs the 12-week baseline'],
  ['signals.cannibalization.aggregate_loss_clicks_ratio_max', 'main §7.3 — validation: aggregate performance loss'],
  ['signals.uncovered_commercial_query.mapped_families_min', 'main §7.3 — maps to ≥ 1 product family'],
  ['signals.existing_page_intent_gap.position_min', 'main §7.3 — ranks 4–20'],
  ['signals.existing_page_intent_gap.position_max', 'main §7.3 — ranks 4–20'],
  ['signals.existing_page_intent_gap.missing_subtopics_min', 'main §7.3 — ≥ 2 subtopics absent'],
  ['signals.existing_page_intent_gap.subtopic_present_on_top_pages_min', 'main §7.3 — present on ≥ 3 of top-5'],
  ['signals.existing_page_intent_gap.serp_top_n', 'main §7.3 — top-5 SERP pages'],
  ['signals.competitor_coverage_gap.competitors_ranking_min', 'main §7.3 — ≥ 2 business competitors'],
  ['signals.competitor_coverage_gap.competitor_position_max', 'main §7.3 — rank ≤ 10'],
  ['signals.competitor_coverage_gap.our_absent_position_max', 'main §7.3 — we hold no position ≤ 20; set to 10, see DECISIONS.md 2026-09-03'],
  ['signals.competitor_coverage_gap.optimize_position_min', 'main §7.3 — relevant URL at 11–30'],
  ['signals.competitor_coverage_gap.optimize_position_max', 'main §7.3 — relevant URL at 11–30'],
  ['signals.product_family_coverage_gap.revenue_share_min', 'main §7.3 — ≥ 10% of 90d revenue'],
  ['signals.product_family_coverage_gap.revenue_window_days', 'main §7.3 — 90d revenue'],
  ['signals.product_family_coverage_gap.keyword_candidates_min', 'main §7.3 — ≥ 1 keyword candidate'],
  ['signals.freshness_opportunity.age_months_min', 'main §7.3 — age > 12 months'],
  ['signals.freshness_opportunity.stagnation_window_weeks', 'main §7.3 — stagnant over 12 weeks'],
  ['signals.freshness_opportunity.serp_set_difference_min', 'main §7.3 — top-5 differs ≥ 40%'],

  // ── Opportunity object & scoring ───────────────────────────────────────────
  ['scoring.create.competitor_gap_source_bonus', 'main §7.6/§9.6.4 — competitor-gap bonus ×1.15'],
  ['scoring.create.business_weight_min', 'main §7.6 — business_weight rescaled to [1.0, 1.5]'],
  ['scoring.create.business_weight_max', 'main §7.6 — business_weight rescaled to [1.0, 1.5]'],
  ['scoring.existing_page.window_days', 'main §7.6 — impressions_28d'],
  ['scoring.existing_page.striking_distance_target_position', 'main §7.6 — target_position = 3'],
  ['scoring.impact.band_tercile_low_max_percentile', 'main §7.6 — impact bands are terciles of percentile rank'],
  ['scoring.impact.band_tercile_medium_max_percentile', 'main §7.6 — impact bands are terciles of percentile rank'],
  ['scoring.confidence.points.gsc_evidence_present', 'main §7.6 — +30 GSC evidence present'],
  ['scoring.confidence.points.evidence_window_at_least_28_days', 'main §7.6 — +20 window ≥ 28 days'],
  ['scoring.confidence.points.evidence_window_at_least_84_days', 'main §7.6 — +10 if ≥ 84'],
  ['scoring.confidence.points.independent_sources_agree', 'main §7.6 — +15 ≥ 2 independent sources'],
  ['scoring.confidence.points.substance_floor_margin', 'main §7.6 — +15 substance floor with margin'],
  ['scoring.confidence.points.no_open_precondition', 'main §7.6 — +10 no open precondition'],
  ['scoring.confidence.points.validated_across_consecutive_scans', 'main §7.6 — +10 validated across ≥ 2 scans'],
  ['scoring.confidence.points.limited_intelligence_penalty', 'main §7.6/§7.11 — −20 Limited Intelligence'],
  ['scoring.confidence.clamp_min', 'main §7.6 — clamped'],
  ['scoring.confidence.clamp_max', 'main §7.6 — clamped'],
  ['scoring.confidence.band_high_min', 'main §7.6 — high ≥ 70'],
  ['scoring.confidence.band_medium_min', 'main §7.6 — medium 40–69'],

  // ── Gates: topic admission, existing-target check, draft grading ───────────
  ['gates.demand_floor.monthly_search_volume_min', 'main §8.2 — demand floor per locale'],
  ['gates.demand_floor.allow_zero_volume_when_pinned', 'main §8.2 — zero-volume auto-reject unless pinned'],
  ['gates.winnability.limited_intelligence_constant', 'main §9.6.4/§7.11 — conservative winnability constant'],
  ['gates.substance_floor.distinct_facts_min', 'main §8.2 — substance inventory'],
  ['gates.substance_floor.contributing_products_min', 'main §8.2 — across enough member products'],
  ['gates.substance_floor.margin_multiple', 'main §7.6 — "passes the substance floor with margin"'],
  ['gates.existing_target_check.match_position_max', 'main §7.7 — mean position ≤ 30 over 28d'],
  ['gates.existing_target_check.window_days', 'main §7.7 — over 28d'],
  ['gates.draft_grading.information_gain_min', 'main §8.4 — information gain ≥ 4'],
  ['gates.draft_grading.factual_grounding_min', 'main §8.4 — grounding ≥ 4'],
  ['gates.draft_grading.other_criteria_min', 'main §8.4 — the rest ≥ 3'],
  ['gates.draft_grading.repair_loops_max', 'main §8.4 — one repair loop, max'],

  // ── Query clusters & the store's own click curve ───────────────────────────
  ['clusters.window_days', 'main §7.3 — clusters are read over the same trailing 28d as the signals'],
  ['clusters.min_query_impressions', 'main §7.3 — a cluster is built from queries; the noise floor is unstated'],
  ['clusters.head_min_tokens', 'main §9.6.3 — head query plus its expansion; how broad a head may be is unstated'],
  ['clusters.head_min_impressions', 'main §9.6.3 — when a narrower search is its own intent is unstated'],
  ['clusters.max_member_queries', 'main §13 query_clusters.member_queries — unbounded in the spec'],
  ['clusters.max_clusters', 'main §13 query_clusters — unbounded in the spec'],
  ['ctr_curve.window_days', 'main §7.3 — the store\'s own fitted curve; the fit window is unstated'],
  ['ctr_curve.max_position', 'main §13 ctr_curve.curve_json — position → expected CTR, range unstated'],
  ['ctr_curve.min_sample_impressions', 'main §13 ctr_curve.sample_n — the fallback trigger, value unstated'],
  ['ctr_curve.min_position_buckets', 'main §7.3 — "fallback: standard curve", conditions unstated'],
  ['ctr_curve.fitted_ctr_min', 'main §7.3 — the fitted curve is the comparison; no clamp is stated'],
  ['ctr_curve.fitted_ctr_max', 'main §7.3 — the fitted curve is the comparison; no clamp is stated'],
  ['ctr_curve.standard_curve', 'main §7.3 — "fallback: standard curve", never given'],

  // ── Learning loop ──────────────────────────────────────────────────────────
  ['learning.replenishment_horizon_days', 'main §9.6.1 — planned horizon below ~60 days'],
  ['learning.replenishment_target_horizon_days', 'main §8.7 — "~3-month backlog"; the target is unstated, see DECISIONS.md 2026-09-03 T4.6'],
  ['learning.labels.maturity_days', 'main §9.6.2 — no judgment before 28 days'],
  ['learning.labels.winner_clicks_store_median_multiple_min', 'main §9.6.2 — clicks ≥ 2× store median'],
  ['learning.labels.winner_position_improvement_min', 'main §9.6.2 — position improved ≥ 5 spots'],
  ['learning.labels.underperformer_clicks_store_median_multiple_max', 'main §9.6.2 — clicks < 0.25× median'],
  ['learning.labels.underperformer_position_min', 'main §9.6.2 — position > 30'],
  ['learning.labels.underperformer_age_days_min', 'main §9.6.2 — after 90 days'],
  ['learning.patterns.activation_min_rated', 'main §9.6.3 — n ≥ 3 rated articles'],
  ['learning.patterns.dominance_share_min', 'main §9.6.3 — ≥ ⅔ dominance'],
  ['learning.patterns.winner_dominant_multiplier', 'main §9.6.3 — ×1.25'],
  ['learning.patterns.underperformer_dominant_multiplier', 'main §9.6.3 — ×0.8'],
  ['learning.patterns.mixed_multiplier', 'main §9.6.3 — ×1.0'],
  ['learning.patterns.multiplier_clamp_min', 'main §9.6.3 — never leave [0.5, 2.0]'],
  ['learning.patterns.multiplier_clamp_max', 'main §9.6.3 — never leave [0.5, 2.0]'],
  ['learning.patterns.recency_window_days', 'main §9.6.3 — trailing 90 days'],
  ['learning.patterns.max_stacked_multipliers', 'main §9.6.4 — the (≤3) active pattern multipliers'],
  ['learning.patterns.dimensions', 'main §9.6.3 + §9.6.10 — four dimensions incl. action_type'],
  ['learning.refresh.position_min', 'main §9.6.5 — mean position 5–15'],
  ['learning.refresh.position_max', 'main §9.6.5 — mean position 5–15'],
  ['learning.refresh.cooldown_days', 'main §9.6.5 — not refreshed in the last 60 days'],
  ['learning.refresh.batch_share_max', 'main §9.6.5 — refreshes ≤ 40% of a batch'],
  ['learning.exploration.reserved_slots_min', 'main §9.6.6 — at least 2 slots'],
  ['learning.exploration.reserved_share_min', 'main §9.6.6 — or 15%, whichever is larger'],
  ['learning.outcomes.maturity_days', 'main §9.6.10 — same 28-day maturity rule'],
  ['learning.outcomes.optimize.improved_position_delta_min', 'main §9.6.10 — position ≥ 2 better'],
  ['learning.outcomes.optimize.improved_ctr_relative_delta_min', 'main §9.6.10 — CTR ≥ +20% relative'],
  ['learning.outcomes.refresh.recovered_clicks_baseline_ratio_min', 'main §9.6.10 — clicks ≥ 0.8× pre-decay baseline'],
  ['learning.outcomes.fix.primary_url_impression_share_min', 'main §9.6.10 — ≥ 70% of cluster impressions'],

  // ── Caps & auto-trips ──────────────────────────────────────────────────────
  ['budgets.optimize.generations_per_account_per_day', 'main §10.2 — 2 generations per account per day'],
  ['budgets.intent_gap.analyses_per_account_per_day', 'main §14.5 — per-account daily cap on intent-gap analysis'],
  ['budgets.intent_gap.scheduled_shortlist_max', 'main §10.3, §14.5 — the scheduled pass shortlists fewer pages than the allowance'],
  ['auto_trips.flag_check_max_staleness_seconds', 'main §14.5 — flags effective within 60s'],
  ['auto_trips.account_llm_spend.trailing_median_multiple_max', 'main §14.5 — > 10× trailing-30-day median'],
  ['auto_trips.account_llm_spend.trailing_median_window_days', 'main §14.5 — trailing-30-day median'],
  ['auto_trips.account_llm_spend.hard_cap_usd_per_day', 'main §14.5 — hard dollar cap'],
  ['auto_trips.dataforseo_spend.global_cap_usd_per_day', 'main §14.5 — global DataForSEO daily cap'],
  ['auto_trips.preview_spend.global_cap_usd_per_day', 'main §14.5 — daily preview LLM spend cap'],
  ['auto_trips.judge_fail_rate.rate_max', 'main §14.5 — judge fail rate > 60%'],
  ['auto_trips.judge_fail_rate.trailing_drafts', 'main §14.5 — trailing 50 drafts'],
  ['auto_trips.publish_error_rate.rate_max', 'main §14.5 — publish API error rate > 20%'],
  ['auto_trips.publish_error_rate.window_hours', 'main §14.5 — over 1h'],

  // ── Keyword & competitor discovery ────────────────────────────────────────
  ['discovery.seed_keywords.candidates_max', 'main §6.6 — ~15–25 candidate terms; the ceiling we price'],
  ['discovery.seed_keywords.keep_max', 'main §6.6 — the strongest ~10–15 are kept'],
  ['discovery.competitors.serp_position_max', 'main §7.2.1 — ranks in the top 10'],
  ['discovery.competitors.appears_in_keywords_min', 'main §7.2.1 — for ≥ 3 of the confirmed keywords (config, §7.10)'],
  ['discovery.competitors.auto_proposed_max', 'main §6.6 — auto-detection proposes at most 5'],
  ['discovery.competitors.seed_serps_max', 'UNSIGNED — how many seed SERPs onboarding buys'],
  ['discovery.cache.keyword_metrics_ttl_days', 'main §12.1 — keyword metrics: 30-day TTL'],
  ['discovery.cache.serp_snapshot_ttl_days', 'main §12.1 — SERP snapshots: 7-day TTL'],

  // ── Search Console sync ────────────────────────────────────────────────────
  ['search_console.backfill_months', 'main §6.7, §12.2 — 16-month history import at connect'],
  ['search_console.backfill_chunk_days', 'UNSIGNED — how much a killed import re-does'],
  ['search_console.daily_sync_lookback_days', 'main §12.2 — the daily pull covers the last N days'],
  ['search_console.data_lag_days', 'main §12.2 — Search Console data lags ~2 days'],
]

function at(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (node === null || typeof node !== 'object') return undefined
    return (node as Record<string, unknown>)[key]
  }, root)
}

describe('signals.config.yaml', () => {
  const config = loadRulesConfig()

  it('loads and schema-validates', () => {
    expect(config.version).toBe(1)
    expect(config.rulesVersion).toMatch(/^[0-9a-f]{64}$/)
  })

  describe('every threshold the spec names exists', () => {
    for (const [path, spec] of NAMED_THRESHOLDS) {
      it(`${path}  (${spec})`, () => {
        const value = at(config.defaults, path)
        expect(value, `${path} missing from signals.config.yaml — ${spec}`).not.toBeUndefined()
      })
    }
  })

  it('covers every signal type in the main §7.3 catalog', () => {
    const configured = Object.keys(config.defaults.signals)
    expect([...SIGNAL_TYPES].sort()).toEqual([...configured].sort())
  })

  it('marks the §7.3 P0 signals as P0', () => {
    const p0 = Object.entries(config.defaults.signals)
      .filter(([, s]) => s.priority === 'P0')
      .map(([name]) => name)
      .sort()
    expect(p0).toEqual(
      [
        'striking_distance',
        'low_ctr_at_strong_rank',
        'content_decay',
        'cannibalization',
        'uncovered_commercial_query',
        'existing_page_intent_gap',
        'competitor_coverage_gap',
        'product_family_coverage_gap',
        'catalog_richness_gap',
        // The founder signed the metadata signal off as P0 rather than P1.
        'missing_or_weak_metadata',
        'product_change_impact',
        'broken_product_reference',
      ].sort(),
    )
  })

  it('carries the §9.6.10 action_type pattern dimension', () => {
    expect(config.defaults.learning.patterns.dimensions).toContain('action_type')
  })
})

describe('rules_version', () => {
  it('is the sha256 of the config file bytes', async () => {
    const { createHash } = await import('node:crypto')
    const expected = createHash('sha256').update(readFileSync(configPath(), 'utf8'), 'utf8').digest('hex')
    expect(loadRulesConfig().rulesVersion).toBe(expected)
  })

  it('changes when any value changes', () => {
    const raw = readFileSync(configPath(), 'utf8')
    const before = loadRulesConfig({ source: raw }).rulesVersion
    const mutated = raw.replace('      position_max: 15\n', '      position_max: 14\n')
    expect(mutated).not.toBe(raw)
    const after = loadRulesConfig({ source: mutated }).rulesVersion
    expect(after).not.toBe(before)
  })
})

/**
 * The document is read by the first caller that needs a number, not when this
 * package is imported — importing it at start-up is what used to stop the whole
 * server from starting. Moving the read later moves the failure later too, so
 * the error it raises is the only warning anyone gets that the configuration is
 * wrong: it has to say which file, and where it looked.
 */
describe('a config file that cannot be read', () => {
  it('names the file and the path it looked in', () => {
    expect(() => loadRulesConfig({ configPath: '/nowhere/at/all/signals.config.yaml' })).toThrow(
      /signals\.config\.yaml could not be read at \/nowhere\/at\/all\/signals\.config\.yaml/,
    )
  })

  it('is a RulesConfigError, so a caller can tell it from any other filesystem failure', () => {
    expect(() => loadRulesConfig({ configPath: '/nowhere/at/all/signals.config.yaml' })).toThrow(
      RulesConfigError,
    )
  })

  it('resolves the real file relative to this package, whoever is running', () => {
    expect(configPath()).toMatch(/packages[/\\]rules[/\\]signals\.config\.yaml$/)
    expect(existsSync(configPath())).toBe(true)
  })
})

describe('document validation', () => {
  it('rejects YAML that does not parse', () => {
    expect(() => loadRulesConfig({ source: 'version: 1\n  defaults: [\n bad' })).toThrow(RulesConfigError)
  })

  it('rejects a document missing a required section', () => {
    expect(() => loadRulesConfig({ source: 'version: 1\ndefaults: {}\n' })).toThrow(/failed schema validation/)
  })

  it('rejects an out-of-range value', () => {
    const raw = readFileSync(configPath(), 'utf8')
    const mutated = raw.replace(
      '      observed_vs_predicted_ctr_ratio_max: 0.6',
      '      observed_vs_predicted_ctr_ratio_max: 1.6',
    )
    expect(() => loadRulesConfig({ source: mutated })).toThrow(/failed schema validation/)
  })

  it('rejects an unknown key, so a typo cannot become a silently-ignored threshold', () => {
    const raw = readFileSync(configPath(), 'utf8')
    const mutated = raw.replace('      position_max: 15\n', '      position_max: 15\n      postion_min: 4\n')
    expect(() => loadRulesConfig({ source: mutated })).toThrow(/failed schema validation/)
  })

  it('rejects a standard click curve with a hole in it', () => {
    // A missing position would read as "nobody ever clicks here", and a store
    // with no history of its own would then have every page called
    // under-clicked. Proved by removing a row rather than by trusting the shape.
    const raw = readFileSync(configPath(), 'utf8')
    const mutated = raw.replace('      "7": 0.0330\n', '')
    expect(() => loadRulesConfig({ source: mutated })).toThrow(/standard_curve is missing positions/)
  })

  it('rejects a locale override that puts a hole in the standard click curve', () => {
    const raw = readFileSync(configPath(), 'utf8')
    const mutated = raw.replace(
      'locales:\n  en:\n    gates:',
      'locales:\n  en:\n    ctr_curve:\n      max_position: 30\n    gates:',
    )
    expect(() => loadRulesConfig({ source: mutated })).toThrow(/locale "en".*standard_curve is missing/s)
  })

  it('rejects a locale override whose merged layer is invalid', () => {
    const raw = readFileSync(configPath(), 'utf8')
    const mutated = raw.replace(
      'locales:\n  en:\n    gates:\n      demand_floor:\n        monthly_search_volume_min: 100',
      'locales:\n  en:\n    gates:\n      demand_floor:\n        monthly_search_volume_typo: 100',
    )
    expect(() => loadRulesConfig({ source: mutated })).toThrow(/locale override "en"/)
  })
})

describe('per-locale override layer (main §7.10)', () => {
  const config = loadRulesConfig()

  it('resolves a full tag through its language subtag', () => {
    expect(config.forLocale('da-DK').gates.demand_floor.monthly_search_volume_min).toBe(
      config.forLocale('da').gates.demand_floor.monthly_search_volume_min,
    )
  })

  it('applies a lower demand floor in a smaller search market than in English (main §8.2)', () => {
    const da = config.forLocale('da-DK').gates.demand_floor.monthly_search_volume_min
    const en = config.forLocale('en-US').gates.demand_floor.monthly_search_volume_min
    expect(da).toBeLessThan(en)
  })

  it('inherits everything the locale layer does not restate', () => {
    expect(config.forLocale('da-DK').learning.refresh.cooldown_days).toBe(
      config.defaults.learning.refresh.cooldown_days,
    )
  })

  it('falls back to defaults for an unknown locale and for none', () => {
    expect(config.forLocale('zz-ZZ')).toBe(config.defaults)
    expect(config.forLocale(null)).toBe(config.defaults)
    expect(config.forLocale(undefined)).toBe(config.defaults)
  })
})

describe('committed snapshot', () => {
  it('matches the loaded config', async () => {
    const config = loadRulesConfig()
    const resolved = {
      version: config.version,
      rules_version: config.rulesVersion,
      defaults: config.defaults,
      locales: Object.fromEntries(config.localeKeys.map((key) => [key, config.forLocale(key)])),
    }
    await expect(`${JSON.stringify(resolved, null, 2)}\n`).toMatchFileSnapshot(
      '../snapshot/loaded-config.json',
    )
  })
})
