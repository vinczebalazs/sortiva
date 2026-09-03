/**
 * Compile-time view of `signals.config.yaml`. The runtime authority is
 * `schema/signals.config.schema.json`, validated at load; these
 * types exist so consumers get a typed accessor instead of `any`.
 */

export type SignalPriority = 'P0' | 'P1'

/** The closed set of signal types. Every one must name a key in the config, or a detected row has no thresholds to be judged by. */
export const SIGNAL_TYPES = [
  'striking_distance',
  'low_ctr_at_strong_rank',
  'content_decay',
  'cannibalization',
  'uncovered_commercial_query',
  'existing_page_intent_gap',
  'competitor_coverage_gap',
  'product_family_coverage_gap',
  'catalog_richness_gap',
  'missing_or_weak_metadata',
  'product_change_impact',
  'broken_product_reference',
  'internal_linking_gap',
  'orphan_page',
  'indexing_issue',
  'wrong_canonical_or_duplicate',
  'content_overlap',
  'freshness_opportunity',
] as const

export type SignalType = (typeof SIGNAL_TYPES)[number]

export interface SignalCommon {
  priority: SignalPriority
  needs_gsc: boolean
}

export interface SignalsConfig {
  striking_distance: SignalCommon & {
    position_min: number
    position_max: number
    window_days: number
    impressions_store_median_multiple_min: number
  }
  low_ctr_at_strong_rank: SignalCommon & {
    position_max: number
    window_days: number
    impressions_store_median_multiple_min: number
    observed_vs_predicted_ctr_ratio_max: number
  }
  content_decay: SignalCommon & {
    window_days: number
    comparison_window_offset_weeks: number
    clicks_ratio_max: number
    position_worsened_min: number
    consecutive_weekly_evaluations_min: number
    baseline_clicks_store_median_multiple_min: number
  }
  cannibalization: SignalCommon & {
    window_days: number
    competing_urls_min: number
    impression_share_min: number
    position_max: number
    leader_changes_min: number
    baseline_offset_weeks: number
    aggregate_loss_clicks_ratio_max: number
  }
  uncovered_commercial_query: SignalCommon & { mapped_families_min: number }
  existing_page_intent_gap: SignalCommon & {
    position_min: number
    position_max: number
    missing_subtopics_min: number
    subtopic_present_on_top_pages_min: number
    serp_top_n: number
  }
  competitor_coverage_gap: SignalCommon & {
    competitors_ranking_min: number
    competitor_position_max: number
    our_absent_position_max: number
    optimize_position_min: number
    optimize_position_max: number
  }
  product_family_coverage_gap: SignalCommon & {
    revenue_share_min: number
    revenue_window_days: number
    keyword_candidates_min: number
  }
  catalog_richness_gap: SignalCommon
  missing_or_weak_metadata: SignalCommon
  product_change_impact: SignalCommon
  broken_product_reference: SignalCommon
  internal_linking_gap?: SignalCommon
  orphan_page?: SignalCommon
  indexing_issue?: SignalCommon
  wrong_canonical_or_duplicate?: SignalCommon
  content_overlap?: SignalCommon
  freshness_opportunity?: SignalCommon & {
    age_months_min: number
    stagnation_window_weeks: number
    serp_set_difference_min: number
  }
}

export interface ScoringConfig {
  create: {
    competitor_gap_source_bonus: number
    business_weight_min: number
    business_weight_max: number
  }
  existing_page: {
    window_days: number
    striking_distance_target_position: number
  }
  impact: {
    score_min: number
    score_max: number
    band_tercile_low_max_percentile: number
    band_tercile_medium_max_percentile: number
  }
  confidence: {
    points: {
      gsc_evidence_present: number
      evidence_window_at_least_28_days: number
      evidence_window_at_least_84_days: number
      independent_sources_agree: number
      substance_floor_margin: number
      no_open_precondition: number
      validated_across_consecutive_scans: number
      limited_intelligence_penalty: number
    }
    independent_sources_min: number
    evidence_window_days_tier_1: number
    evidence_window_days_tier_2: number
    consecutive_scans_min: number
    clamp_min: number
    clamp_max: number
    band_high_min: number
    band_medium_min: number
  }
}

export interface GatesConfig {
  demand_floor: {
    monthly_search_volume_min: number
    allow_zero_volume_when_pinned: boolean
  }
  winnability: {
    limited_intelligence_constant: number
    minimum: number
  }
  substance_floor: {
    distinct_facts_min: number
    populated_fields_per_product_min: number
    contributing_products_min: number
    margin_multiple: number
  }
  existing_target_check: {
    window_days: number
    match_position_max: number
  }
  evidence_pack_check: {
    distinct_claims_min: number
    boilerplate_repeat_share_min: number
    boilerplate_ratio_max: number
  }
  draft_grading: {
    criterion_score_min: number
    criterion_score_max: number
    information_gain_min: number
    factual_grounding_min: number
    other_criteria_min: number
    repair_loops_max: number
  }
  draft_lints: {
    near_duplicate_similarity_max: number
    near_duplicate_shingle_words: number
    keyword_density_max: number
    length_target_floor_ratio: number
    numeric_agreement_tolerance: number
    contradiction_subject_overlap_min: number
  }
}

export type PatternDimension = 'intent_class' | 'family_id' | 'keyword_cluster' | 'action_type'

export interface LearningConfig {
  replenishment_horizon_days: number
  labels: {
    maturity_days: number
    window_days: number
    winner_clicks_store_median_multiple_min: number
    winner_position_improvement_min: number
    underperformer_clicks_store_median_multiple_max: number
    underperformer_position_min: number
    underperformer_age_days_min: number
  }
  patterns: {
    activation_min_rated: number
    dominance_share_min: number
    winner_dominant_multiplier: number
    underperformer_dominant_multiplier: number
    mixed_multiplier: number
    multiplier_clamp_min: number
    multiplier_clamp_max: number
    recency_window_days: number
    max_stacked_multipliers: number
    dimensions: PatternDimension[]
  }
  refresh: {
    position_min: number
    position_max: number
    window_days: number
    cooldown_days: number
    batch_share_max: number
  }
  exploration: {
    reserved_slots_min: number
    reserved_share_min: number
  }
  outcomes: {
    maturity_days: number
    window_days: number
    optimize: {
      improved_position_delta_min: number
      improved_ctr_relative_delta_min: number
      impressions_not_collapsed_ratio_min: number
    }
    refresh: { recovered_clicks_baseline_ratio_min: number }
    fix: { primary_url_impression_share_min: number }
  }
}

/**
 * How much Search Console history we hold and how often we go back for it.
 * The window a signal looks at is only as good as the data behind it, which is
 * why these sit with the detection numbers rather than inside the sync job.
 */
/**
 * What onboarding buys from the search-data vendor and how long we keep it:
 * how many search terms the model proposes, how many survive enrichment, which
 * domains count as ranking against the store, and how long a bought answer is
 * trusted before it is bought again.
 */
export interface DiscoveryConfig {
  seed_keywords: {
    candidates_max: number
    keep_max: number
  }
  competitors: {
    serp_position_max: number
    appears_in_keywords_min: number
    auto_proposed_max: number
    seed_serps_max: number
  }
  cache: {
    keyword_metrics_ttl_days: number
    serp_snapshot_ttl_days: number
  }
}

export interface SearchConsoleConfig {
  backfill_months: number
  backfill_chunk_days: number
  daily_sync_lookback_days: number
  data_lag_days: number
}

/**
 * How a query cluster is assembled: one search intent, made of a head query and
 * the near-variants of it the store is actually shown for. Detection reasons
 * about clusters rather than single searches, so these numbers decide which
 * searches the engine can see at all.
 */
export interface ClustersConfig {
  window_days: number
  min_query_impressions: number
  head_min_tokens: number
  head_min_impressions: number
  max_member_queries: number
  max_clusters: number
}

/**
 * How the store's own position-to-click-rate curve is fitted, and the plain
 * table used instead when the store has too little history to fit one from.
 */
export interface CtrCurveConfig {
  window_days: number
  max_position: number
  min_sample_impressions: number
  min_position_buckets: number
  fitted_ctr_min: number
  fitted_ctr_max: number
  /** Click rate by position, keyed by the position written as a string. Complete from 1 to `max_position`; the loader refuses a document where it is not. */
  standard_curve: Readonly<Record<string, number>>
}

/**
 * Numbers that shape the draft itself, once Gate 2 has cleared the pack to
 * write from — main §9.2.
 */
export interface GenerationConfig {
  length: {
    serp_word_count_multiple_min: number
    serp_word_count_multiple_max: number
    fallback_word_count_min: number
  }
  internal_links: {
    min_count: number
  }
}

export interface BudgetsConfig {
  optimize: { generations_per_account_per_day: number }
  intent_gap: { analyses_per_account_per_day: number }
}

export interface AutoTripsConfig {
  flag_check_max_staleness_seconds: number
  account_llm_spend: {
    trailing_median_multiple_max: number
    trailing_median_window_days: number
    hard_cap_usd_per_day: number
  }
  dataforseo_spend: { global_cap_usd_per_day: number }
  preview_spend: { global_cap_usd_per_day: number }
  judge_fail_rate: { rate_max: number; trailing_drafts: number }
  publish_error_rate: { rate_max: number; window_hours: number }
}

/** One fully-resolved set of thresholds: defaults, or defaults + a locale layer. */
export interface RulesLayer {
  signals: SignalsConfig
  scoring: ScoringConfig
  gates: GatesConfig
  learning: LearningConfig
  generation: GenerationConfig
  budgets: BudgetsConfig
  auto_trips: AutoTripsConfig
  discovery: DiscoveryConfig
  search_console: SearchConsoleConfig
  clusters: ClustersConfig
  ctr_curve: CtrCurveConfig
}

export interface RulesDocument {
  version: number
  defaults: RulesLayer
  locales?: Record<string, DeepPartial<RulesLayer>>
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}
