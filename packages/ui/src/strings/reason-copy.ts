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

/**
 * The `{placeholders}` a sentence expects the engine to fill.
 *
 * A sentence that changes shape with a number writes both shapes inline —
 * `{n, plural, one {page} other {pages}}` — and the words inside are the
 * catalogue's own, not values anybody sends. Reading them as placeholders would
 * fail every sentence that states both forms, and would miss the one name that
 * really does have to arrive: the number the block chooses on.
 */
export function placeholdersIn(reasonKey: string): readonly string[] {
  const sentence = (en as Record<string, string>)[catalogKeyFor(reasonKey)] ?? ''
  const names: string[] = []
  for (let i = 0; i < sentence.length; ) {
    const plural = /^\{(\w+),\s*plural,/.exec(sentence.slice(i))
    if (plural) {
      names.push(plural[1]!)
      let depth = 0
      do {
        if (sentence[i] === '{') depth += 1
        else if (sentence[i] === '}') depth -= 1
        i += 1
      } while (i < sentence.length && depth > 0)
      continue
    }
    const simple = /^\{(\w+)\}/.exec(sentence.slice(i))
    if (simple) {
      names.push(simple[1]!)
      i += simple[0].length
      continue
    }
    i += 1
  }
  return [...new Set(names)]
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
  // Three sentences for one signal, because two different things confirm it and
  // only one of them is a change: either the page Google leads with keeps
  // moving, or the search simply earns fewer clicks than it did a quarter ago.
  // The detector records which one carried the finding, and that picks the
  // sentence rather than filling in a blank.
  'cannibalization.fix_alternation': ['competing_urls', 'leader_changes'],
  'cannibalization.fix_aggregate_loss': ['competing_urls', 'leader_changes'],
  'cannibalization.fix_both': ['competing_urls', 'leader_changes'],
  // Kept because rows written before 2026-09-09 carry this key. Nothing produces
  // it any more; deleting its sentence would leave those cards with no
  // explanation, which the test in this package pins.
  'cannibalization.fix': ['competing_urls', 'leader_changes'],
  'uncovered_commercial_query.create': ['volume'],
  'uncovered_commercial_query.create_with_link': ['volume'],
  'competitor_coverage_gap.create': ['competitors', 'best_competitor_position'],
  'product_family_coverage_gap.create': ['family', 'revenue_share'],
  'missing_or_weak_metadata.optimize': ['missing_fields', 'duplicate_fields'],
  'existing_page_intent_gap.optimize': ['position', 'missing_subtopics'],
  // No numbers at all: the machine word that told the two conditions apart is
  // now what picks between two sentences rather than something printed.
  'indexing_issue.fix_not_indexed': [],
  'indexing_issue.fix_canonical': [],
}

/**
 * Numbers the weekly scan sends that its sentences still do not print, and why
 * each one stays unprinted.
 *
 * Five of the nine have gone. They were phrased around because the catalogue
 * could not say "1 page", and the sentences that lost the most by it now state
 * their number with both forms written out, the renderer choosing between them.
 *
 * The four that remain are not waiting on machinery. Each would make its
 * sentence worse, or make it lie:
 *
 * - `impressions` — how often the store came up in search for this subject. The
 *   number means nothing without the period it covers, and a reason sentence is
 *   never given one. The drawer already shows it as a chip beside the window it
 *   was measured over, which is the honest place for it.
 * - `leader_changes` — how many times Google switched which of the store's own
 *   pages it led with. **It is legitimately nought.** The finding is confirmed
 *   either by the leader flipping *or* by the search losing clicks, so a
 *   sentence stating this number would say "changed 0 times" to every merchant
 *   whose finding was confirmed the second way.
 * - `missing_fields` and `duplicate_fields` — how many of a page's search title
 *   and description are absent, and how many repeat another page's. Either is
 *   legitimately nought, because one of the two conditions alone raises the
 *   signal, so one sentence stating both would announce a nought to half the
 *   merchants who read it. Saying it properly means two keys and a producer
 *   choosing between them — the same split `indexing_issue` was given — and the
 *   producer is not this package.
 */
export const COUNTS_PHRASED_AROUND: readonly string[] = [
  'impressions',
  'leader_changes',
  'missing_fields',
  'duplicate_fields',
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
  'cannibalization.fix_alternation',
  'cannibalization.fix_aggregate_loss',
  'cannibalization.fix_both',
  'cannibalization.fix',
  'uncovered_commercial_query.create_with_link',
  'uncovered_commercial_query.create',
  'existing_target.prefer_optimize',
  'competitor_coverage_gap.create',
  'product_family_coverage_gap.create',
  'quality_rejection.insufficient_richness',
  'missing_or_weak_metadata.optimize',
  'existing_page_intent_gap.optimize',
  'indexing_issue.fix_not_indexed',
  'indexing_issue.fix_canonical',
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
 * **These sentences may now carry `{placeholders}`, and until recently could
 * not.** The values were always measured and never arrived anywhere they could
 * be printed: the calendar sent every chip an empty bag, Gate 1 folded its
 * measurements into an audit column one level below where the read-back looks,
 * and Gate 2 recorded none at all. All three are fixed, so a held day now fills
 * both of its sentences — why it was planned, and why it was stopped — from the
 * same measurements, and six of the sentences carry those measurements today.
 *
 * Three values are still deliberately unprinted. `winnability` and
 * `boilerplate_ratio` arrive as fractions — 0.83, not 83 — and a merchant
 * reading "0.83" learns nothing; printing them as percentages means the gate
 * sending a percentage, not the copy dividing. `via` names which of our data
 * sources found the page (`gsc`, `content_mapping`, `limited_intelligence`) and
 * is machine vocabulary rather than English.
 *
 * The table stays because it is the contract the copy is written against: a
 * sentence asking for something no producer sends still fails the test below,
 * which is how eleven wordless keys survived unnoticed in the first place.
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
 * The one explanation on a held day that no gate wrote.
 *
 * A gate decision row stores the key of its own sentence, and a row can carry
 * none. The calendar used to answer that hole with Gate 1's key, which resolves
 * to a specific finding about the merchant's product descriptions — presented
 * under whichever check actually stopped the day, and indistinguishable on
 * screen from a reason we had measured. The calendar sends this key instead,
 * and the sentence behind it admits the gap rather than inventing a cause.
 *
 * It carries no values on purpose: what the row did measure belongs to the
 * sentence that was never written, not to this one, so a blank here could only
 * print raw.
 */
export const UNRECORDED_REASON_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'gate.reason_unrecorded': [],
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
  ...Object.keys(UNRECORDED_REASON_PARAMS),
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
