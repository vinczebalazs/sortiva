import type { OpportunityAction } from '../contracts/opportunities'
import type { CannibalizationSignal } from '../signals/cannibalization'
import type { CompetitorGapSignal } from '../signals/competitor-gap'
import type { ContentDecaySignal } from '../signals/decay'
import type { FamilyCoverageGapSignal } from '../signals/family-coverage'
import type { LowCtrSignal } from '../signals/low-ctr'
import type { MetadataSignal } from '../signals/metadata'
import type { RichnessGapSignal } from '../signals/richness-gap'
import type { StrikingDistanceSignal } from '../signals/striking-distance'
import type { UncoveredQuerySignal } from '../signals/uncovered-query'
import type { ExistingPageIntentGapSignal, IndexingIssueSignal } from './p1-signal-shapes'

/**
 * "What is true" and "what to do about it" are different questions, answered
 * by different code (main §7.1, invariant 7) — this file only ever answers the
 * second one, and only from evidence a detector already produced. Nothing here
 * calls a detector, reads the database, or invents a fact; a signal that needs
 * more evidence than it already carries to decide its action is a signal that
 * should have carried more evidence.
 *
 * Every branch below is traceable to main §7.3's "Typical action" column or
 * §7.8's mapping table, and the eight worked examples plus the competitor-gap
 * #18 fixture (`action-selection.test.ts`) are the acceptance test for the
 * whole file.
 */

/** Every signal shape this function knows how to turn into an action. A signal type absent from this union is a compile error at the call site, not a silent miss. */
export type DetectedSignal =
  | StrikingDistanceSignal
  | LowCtrSignal
  | ContentDecaySignal
  | CannibalizationSignal
  | UncoveredQuerySignal
  | CompetitorGapSignal
  | FamilyCoverageGapSignal
  | RichnessGapSignal
  | MetadataSignal
  | ExistingPageIntentGapSignal
  | IndexingIssueSignal

export interface ActionSelectionContext {
  /**
   * An open FIX opportunity of a blocking kind already sits on this same
   * entity (indexing, canonical — main §7.9's "technical blockers precede
   * content"). Naming which one is a cross-opportunity lookup this function
   * cannot make on its own — the caller (the repository, which can see every
   * open row for the entity) supplies it. Absent or null means none is known.
   */
  readonly openTechnicalBlocker?: string | null
}

export interface ActionSelectionResult {
  readonly action: OpportunityAction
  readonly entityType: 'query_cluster' | 'url' | 'family' | 'article' | 'product'
  readonly entityRef: string
  /** Non-empty ⇒ the opportunity is `blocked` (HOLD renders as this too). */
  readonly preconditions: readonly string[]
}

function withBlocker(
  result: Omit<ActionSelectionResult, 'preconditions'>,
  own: readonly string[],
  context: ActionSelectionContext | undefined,
): ActionSelectionResult {
  const blocker = context?.openTechnicalBlocker
  return { ...result, preconditions: blocker ? [...own, blocker] : own }
}

/**
 * §7.3's own annotation for this signal, and only this one, splits the action
 * by who owns the page: a store page is a recommendation (OPTIMIZE), our own
 * article is rewritten through the generation pipeline (REFRESH) — main §7.4,
 * §10.5. No other signal in the table carries that split, so none of the
 * branches below apply it.
 */
function refreshIfOurs(pageType: string): 'OPTIMIZE' | 'REFRESH' {
  return pageType === 'article_ours' ? 'REFRESH' : 'OPTIMIZE'
}

export function selectAction(
  signal: DetectedSignal,
  context?: ActionSelectionContext,
): ActionSelectionResult {
  switch (signal.signalType) {
    case 'striking_distance':
      return withBlocker(
        { action: refreshIfOurs(signal.pageType), entityType: 'url', entityRef: signal.page },
        [],
        context,
      )

    case 'low_ctr_at_strong_rank':
      // The spec's own row states only "OPTIMIZE (title/meta/snippet)" — no
      // page-type split, unlike Striking Distance. See DECISIONS.
      return withBlocker(
        { action: 'OPTIMIZE', entityType: 'url', entityRef: signal.page },
        [],
        context,
      )

    case 'content_decay':
      // REFRESH always: main §7.8's own example ("A previously proven asset is
      // losing performance") names no technical-cause branch, and this card
      // has no canonical/indexing detector to feed one (the §7.8 row
      // "Content decay + canonical error → FIX" needs `indexing_issue`, which
      // is a P1 signal nothing detects yet — see `openTechnicalBlocker` for
      // where that would attach once it exists).
      return withBlocker(
        { action: 'REFRESH', entityType: 'url', entityRef: signal.page },
        [],
        context,
      )

    case 'cannibalization':
      // FIX: every task the spec names for this row — primary-page
      // designation, consolidation, canonical recommendation — is a
      // structural fix, not new copy. The row also allows OPTIMIZE, and the
      // worked-example fixture accepts either; FIX is the one this card
      // commits to. See DECISIONS.
      return withBlocker(
        { action: 'FIX', entityType: 'query_cluster', entityRef: signal.clusterHead },
        [],
        context,
      )

    case 'uncovered_commercial_query':
      // The detector has already run the existing-target check (it throws if
      // it hasn't, `UncheckedCandidateError`) and only reaches here when no
      // strong match exists — a weak match still means CREATE, with the link
      // task `build.ts` attaches from `weakExistingTarget`.
      return withBlocker(
        { action: 'CREATE', entityType: 'query_cluster', entityRef: signal.keyword },
        [],
        context,
      )

    case 'competitor_coverage_gap':
      // Today's founder-set threshold (DECISIONS 2026-09-03): a middling page
      // of ours (11–30) converts this to OPTIMIZE; nothing there means CREATE.
      // This is the #18 fixture the card's done-when names.
      return withBlocker(
        {
          action: signal.ourRankingUrl ? 'OPTIMIZE' : 'CREATE',
          entityType: 'query_cluster',
          entityRef: signal.keyword,
        },
        [],
        context,
      )

    case 'product_family_coverage_gap':
      // The detector already excludes any family with mapped content that
      // ranks or is ours, so every row here is a genuine gap.
      return withBlocker(
        { action: 'CREATE', entityType: 'family', entityRef: signal.familyId },
        [],
        context,
      )

    case 'catalog_richness_gap':
      // HOLD is the one action whose preconditions are never empty by
      // construction — the signal's entire premise is a blocked precondition.
      return {
        action: 'HOLD',
        entityType: 'query_cluster',
        entityRef: signal.keyword,
        preconditions: ['catalog_richness_gap'],
      }

    case 'missing_or_weak_metadata':
      return withBlocker(
        { action: 'OPTIMIZE', entityType: 'url', entityRef: signal.page },
        [],
        context,
      )

    case 'existing_page_intent_gap':
      return withBlocker(
        { action: 'OPTIMIZE', entityType: 'url', entityRef: signal.page },
        [],
        context,
      )

    case 'indexing_issue':
      return withBlocker(
        { action: 'FIX', entityType: 'url', entityRef: signal.page },
        [],
        context,
      )

    default: {
      const exhaustive: never = signal
      throw new Error(`selectAction: no branch for signal ${JSON.stringify(exhaustive)}`)
    }
  }
}
