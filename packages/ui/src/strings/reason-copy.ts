import { driftPolicies } from '@sortiva/core'
import en from '../../strings/en.json'
import { catalogKeyFor } from '../opportunities/why'

/**
 * Which explanations the product can be asked for, and which ones it actually
 * has words for.
 *
 * The renderer answers a key it has no sentence for with an honest admission
 * ("the reasoning for this one isn't available yet") and carries on. That is
 * the right thing to show a merchant — better than a raw key, and far better
 * than a crash — but it is also why two whole families of explanation shipped
 * blank without anyone noticing: nothing anywhere compared the set of keys the
 * engine can emit against the set the catalogue holds.
 *
 * This file is that comparison, so the gap fails a build instead of reaching a
 * merchant. The loudness lives here, in CI, and deliberately not at runtime.
 */

/** A sentence exists for this key, whether under `template.` or an alias. */
export function hasCopy(reasonKey: string): boolean {
  return (en as Record<string, string>)[catalogKeyFor(reasonKey)] !== undefined
}

export function reasonKeysWithoutCopy(keys: readonly string[]): readonly string[] {
  return keys.filter((key) => !hasCopy(key))
}

/** The `{placeholders}` a sentence expects the engine to fill. */
export function placeholdersIn(reasonKey: string): readonly string[] {
  const sentence = (en as Record<string, string>)[catalogKeyFor(reasonKey)] ?? ''
  return [...sentence.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!)
}

/**
 * The explanations a drifted article can be given, worked out from the drift
 * policy table rather than typed out — so a new kind of drift arrives here with
 * no sentence and fails, instead of arriving on a merchant's screen blank.
 *
 * Mirrors the key `buildDriftOpportunity` composes. The pairing is held in
 * place from the other side too: the repair suite pins the key a deleted
 * product produces.
 */
export function repairReasonKeys(): readonly string[] {
  return driftPolicies().map((policy) =>
    policy.signalType === 'broken_product_reference'
      ? 'broken_product_reference.fix'
      : `product_change_impact.${policy.kind}`,
  )
}

/**
 * The numbers the weekly scan hands the renderer, per reason.
 *
 * Mirrors `reasonFor` in `packages/core/src/opportunities/reasons.ts`, which is
 * the only producer of these keys. A sentence that asks for anything outside
 * this prints the placeholder to a merchant verbatim — `{position}` on screen —
 * so the test below is what stops a well-meant edit doing that.
 *
 * A sentence need not use every number offered. Several deliberately do not:
 * see the note on plurals below.
 */
export const SCAN_REASON_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'striking_distance.optimize': ['position', 'impressions'],
  'striking_distance.refresh_ours': ['position', 'impressions'],
  'low_ctr_at_strong_rank.optimize': ['position', 'ctr_ratio', 'impressions'],
  'content_decay.refresh': ['from_position', 'to_position', 'clicks_before', 'clicks_after'],
  'cannibalization.fix': ['competing_urls', 'leader_changes'],
  'uncovered_commercial_query.create': ['volume'],
  'uncovered_commercial_query.create_with_link': ['volume'],
  'competitor_coverage_gap.create': ['competitors', 'best_competitor_position'],
  'product_family_coverage_gap.create': ['family', 'revenue_share'],
  'missing_or_weak_metadata.optimize': ['missing_fields', 'duplicate_fields'],
  'existing_page_intent_gap.optimize': ['position', 'missing_subtopics'],
  'indexing_issue.fix': ['reason'],
}

/**
 * Why several of those numbers go unused, which is a deliberate limit rather
 * than an oversight.
 *
 * The catalogue has no singular and plural forms, so a sentence reading
 * "{competing_urls} pages" prints "1 pages" the day a count is one. Two
 * sentences already shipped with that fault. Rather than add two more, the
 * counts that can legitimately be one are phrased around — "more than one of
 * your pages is competing" carries the same meaning and cannot read wrong —
 * and only numbers that are safe at any value are printed: positions,
 * percentages, and a monthly search volume that is never one for a query that
 * cleared the demand floor.
 *
 * Fixing it properly means giving the catalogue plural forms, which is a change
 * to the renderer every lane shares.
 */
export const COUNTS_PHRASED_AROUND: readonly string[] = [
  'impressions',
  'clicks_before',
  'clicks_after',
  'competing_urls',
  'leader_changes',
  'competitors',
  'missing_fields',
  'duplicate_fields',
  'missing_subtopics',
  'reason',
]

/** The only two numbers the repair path hands the renderer. */
export const REPAIR_REASON_PARAMS: readonly string[] = ['article_id', 'references']

/**
 * Every reason an opportunity row can carry, which is every sentence the
 * Opportunities card, the drawer, the calendar popover and the dashboard can
 * be asked to render as a "why".
 *
 * Gate rejections and precondition lines are a separate family with their own
 * producers; they reach the same renderer and want the same treatment.
 */
export const OPPORTUNITY_REASON_KEYS: readonly string[] = [
  // The weekly scan's signals.
  'striking_distance.refresh_ours',
  'striking_distance.optimize',
  'low_ctr_at_strong_rank.optimize',
  'content_decay.refresh',
  'cannibalization.fix',
  'uncovered_commercial_query.create_with_link',
  'uncovered_commercial_query.create',
  'existing_target.prefer_optimize',
  'competitor_coverage_gap.create',
  'product_family_coverage_gap.create',
  'quality_rejection.insufficient_richness',
  'missing_or_weak_metadata.optimize',
  'existing_page_intent_gap.optimize',
  'indexing_issue.fix',
  // A published article of ours the merchant asked us to rewrite.
  'freshness_opportunity.requested',
  'freshness_opportunity.our_own_article',
  ...repairReasonKeys(),
]

/**
 * The three values every deterministic check hands the renderer when it stops a
 * draft: how many faults it found, and where and what the first one was.
 *
 * Mirrors `lintReason` in `packages/core/src/gates/gate3/gate3.ts`, which
 * builds the key `gate3.<category>` for each of the eight categories below.
 */
const LINT_REASON_PARAMS: readonly string[] = ['issue_count', 'first_location', 'first_detail']

/**
 * The values the quality gate hands the renderer, per reason.
 *
 * Mirrors `runGate3` in `packages/core/src/gates/gate3/gate3.ts`, the only
 * producer of these keys, exactly as `SCAN_REASON_PARAMS` mirrors the weekly
 * scan's. The eight lint categories come from `LintCategory`; the last three are
 * written by the grader's own branches.
 *
 * **`first_justification` is the one sentence in the product a model wrote.**
 * Everywhere else the words are ours and the engine supplies only numbers. The
 * founder ruled on 2026-09-04 that the grader's written objection may reach a
 * merchant, and that it is always in English whatever language the store
 * publishes in, because a mixed-language sentence is worse than either language
 * alone. It is passed through word for word and nothing rewrites it.
 */
export const GATE_REASON_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'gate3.structure': LINT_REASON_PARAMS,
  'gate3.citations': LINT_REASON_PARAMS,
  'gate3.assertion_strength': LINT_REASON_PARAMS,
  'gate3.volatile_values': LINT_REASON_PARAMS,
  'gate3.length': LINT_REASON_PARAMS,
  'gate3.internal_links': LINT_REASON_PARAMS,
  'gate3.keyword_stuffing': LINT_REASON_PARAMS,
  'gate3.near_duplicate': LINT_REASON_PARAMS,
  'gate3.contradiction': ['conflict_count', 'first_detail'],
  'gate3.no_information_gain': ['failed_criteria', 'first_justification'],
  'gate3.below_quality_bar': ['failed_criteria', 'first_justification'],
}

/**
 * The values the topic-admission checks hand the renderer, per reason.
 *
 * Gate 1 (`packages/core/src/gates/gate1.ts`) decides whether a topic is worth
 * writing at all; Gate 2 (`packages/core/src/generation/gate2.ts`) decides
 * whether the research gathered for it is worth drafting from; the last two are
 * why a day holds the topic it holds, written by the calendar routes.
 *
 * **Every sentence for these is deliberately free of `{placeholders}`, and the
 * numbers below are all listed as offered-but-unused.** The values exist and are
 * measured, but no screen that renders one of these keys is given them today:
 * the calendar sends an empty bag with every chip's why-line, Gate 1 folds its
 * values into an audit column under a shape the read-back does not look at, and
 * Gate 2 stores none at all. A sentence with a blank in it would therefore print
 * the blank — a merchant reading the literal text `{keyword}`. They are recorded
 * here so that the sentences can be given their numbers the day the values
 * actually arrive, and so the test below still catches a sentence that asks for
 * something nothing anywhere measures.
 */
export const ADMISSION_REASON_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'gate1.admitted': [],
  'gate1.admitted_pinned_despite_zero_volume': ['keyword'],
  'gate1.rejected_zero_volume': ['keyword', 'monthly_search_volume', 'monthly_search_volume_min'],
  'gate1.rejected_not_winnable': ['keyword', 'winnability', 'minimum'],
  'gate1.rejected_off_catalog': ['keyword'],
  'gate1.converted_existing_target_optimize': ['keyword', 'url', 'via'],
  'gate1.converted_existing_target_refresh': ['keyword', 'url', 'via'],
  'gate1.held_insufficient_substance': [
    'keyword',
    'distinct_facts',
    'distinct_facts_required',
    'products_needing_detail',
  ],
  'gate2.held_thin_pack': [
    'distinct_claims',
    'distinct_claims_min',
    'boilerplate_ratio',
    'boilerplate_ratio_max',
  ],
  // The calendar builds these two itself and has nothing to interpolate.
  'topic.auto': [],
  'topic.manual_addition': [],
}

/**
 * Every reason a gate can put on a held day or a held article, and every
 * why-line a calendar chip can carry.
 *
 * The three gates and the calendar write these; nothing else does. Listing them
 * beside the opportunity reasons is what stops the two families being checked
 * to different standards — the gate sentences shipped unreachable for the life
 * of the feature precisely because only the opportunity family was ever
 * compared against the catalogue.
 *
 * `gate3.lint` is deliberately absent: the fallback that would build it cannot
 * be reached, because a draft only fails the deterministic checks when there is
 * a fault to name, and the fault carries the category. Listing it would demand a
 * sentence for a key nothing produces, which is the other half of the same
 * fault this file exists to catch.
 */
export const GATE_REASON_KEYS: readonly string[] = [
  ...Object.keys(GATE_REASON_PARAMS),
  ...Object.keys(ADMISSION_REASON_PARAMS),
]

/**
 * Reasons the product can produce today that still have no words.
 *
 * It is empty, and the test below is what keeps it that way: a new signal
 * arriving without a sentence fails there rather than reaching a merchant as
 * "the reasoning for this one isn't available yet".
 *
 * It has been non-empty twice, both times because a whole family of key had
 * never been compared against the catalogue — first the Opportunities screen's
 * own signals, then the eleven gate-and-calendar keys, of which `topic.auto`
 * alone was the why-line on every chip in the content calendar. Both families
 * now have sentences. The list stays because the honest thing to do with a key
 * that has no words yet is to name it here, where it fails loudly for us and
 * degrades quietly for a merchant.
 */
export const REASON_KEYS_AWAITING_COPY: readonly string[] = []

/**
 * What a merchant sees a signal *called*, which is a second family of copy with
 * the same failure and a quieter one.
 *
 * A missing sentence renders an honest admission. A missing *name* renders a
 * machine-generated one — `missing_or_weak_metadata` came out as "Missing Or
 * Weak Metadata" — because the lookup falls back to humanising the key. That
 * degrades so gracefully nobody noticed for the life of the project, and the
 * two that were wrong had real copy sitting under abbreviated keys the engine
 * never builds (`missing_metadata`, `wrong_canonical`).
 *
 * So the list is derived from the reason keys rather than typed out: a signal
 * that can put a card on screen is a signal whose name that card shows, and a
 * hand-written list here would have the same blind spot the copy did. Derived
 * rather than imported from the rules package because `packages/ui` does not
 * depend on it, and adding that dependency costs every other lane a reinstall.
 */
export function signalTypesOnCards(): readonly string[] {
  // Two reason keys borrow a pinned Appendix A sentence through an alias
  // (`existing_target.prefer_optimize`, `quality_rejection.insufficient_richness`),
  // so their first segment names the borrowed copy rather than the signal that
  // produced the card. Keys that resolve to `template.` are the ones whose
  // prefix really is a signal type.
  const own = OPPORTUNITY_REASON_KEYS.filter((key) => catalogKeyFor(key).startsWith('template.'))
  return [...new Set(own.map((key) => key.split('.')[0]!))]
}

export function signalNamesWithoutCopy(): readonly string[] {
  return signalTypesOnCards().filter(
    (type) => (en as Record<string, string>)[`opportunities.signal.${type}`] === undefined,
  )
}

/**
 * Names sitting in the catalogue under a key nothing produces.
 *
 * The half that hid the fault: `missing_metadata` and `wrong_canonical` held
 * perfectly good copy that no card could ever reach, because the engine builds
 * `missing_or_weak_metadata` and `wrong_canonical_or_duplicate`. Written copy
 * and a missing name looked identical from every direction anyone checked.
 */
export function signalNamesNothingBuilds(): readonly string[] {
  const onCards = new Set(signalTypesOnCards())
  return Object.keys(en as Record<string, string>)
    .filter((key) => key.startsWith('opportunities.signal.'))
    .map((key) => key.replace('opportunities.signal.', ''))
    .filter((type) => !onCards.has(type))
}
