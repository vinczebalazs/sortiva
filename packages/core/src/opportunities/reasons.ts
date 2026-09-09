import type { DetectedSignal } from './action-selection'

/**
 * The key and the numbers a why-line is built from — never the sentence
 * itself. `packages/ui`'s renderer (`why.ts`, already built) looks the key up
 * in the string catalogue and fills it with these params; nothing here writes
 * English, and this module has no model client to write it with (main §7.1,
 * §9.6.8 — same rule as the calendar why-line, same renderer).
 *
 * Copy for the keys this file introduces lives in `packages/ui/strings`, which
 * is Lane F's directory, not this card's — see the session report. Until that
 * copy exists, the renderer's own fallback (`opportunities.whyUnavailable`)
 * shows rather than a raw key or nothing, which is the renderer's designed
 * behaviour for exactly this gap, not a defect of this file.
 */

export interface TemplatedReason {
  readonly reasonTemplateKey: string
  readonly reasonParams: Readonly<Record<string, string | number>>
}

/** Numbers only, never a word already decided by copy — the same discipline the detectors themselves already keep in `evidence`. */
export function reasonFor(signal: DetectedSignal, action: string): TemplatedReason {
  switch (signal.signalType) {
    case 'striking_distance':
      return {
        reasonTemplateKey:
          action === 'REFRESH' ? 'striking_distance.refresh_ours' : 'striking_distance.optimize',
        reasonParams: { position: signal.position, impressions: signal.clusterImpressions },
      }

    case 'low_ctr_at_strong_rank':
      return {
        reasonTemplateKey: 'low_ctr_at_strong_rank.optimize',
        reasonParams: {
          position: signal.position,
          ctr_ratio: Math.round(signal.ctrRatio * 100),
          impressions: signal.clusterImpressions,
        },
      }

    case 'content_decay':
      return {
        reasonTemplateKey: 'content_decay.refresh',
        reasonParams: {
          from_position: signal.baselinePosition,
          to_position: signal.currentPosition,
          clicks_before: signal.baselineClicks,
          clicks_after: signal.currentClicks,
        },
      }

    case 'cannibalization': {
      // Two different things can confirm this finding, and only one of them is
      // a change: either the page Google leads with keeps moving week to week,
      // or the search simply earns fewer clicks than it did a quarter ago. One
      // sentence covering both told every merchant in the second group that
      // Google keeps switching, which for them had not happened. The ground the
      // detector recorded picks the sentence rather than filling one.
      const { validation } = signal
      if (!validation.validated) {
        // Only the detector's validated findings become opportunities. One that
        // failed validation reaching here means it was taken from the wrong
        // half of the detector's result, and there is no true sentence to give
        // it — the same refusal `assertClearedToCreate` makes for a CREATE with
        // no existing-target check behind it.
        throw new Error(
          `reasonFor: cannibalization on "${signal.clusterHead}" did not pass validation (${validation.reason}), so it has no reason to show`,
        )
      }
      const reasonParams = {
        competing_urls: signal.competing.length,
        // Sent but never printed, on purpose: it is legitimately nought on
        // every finding the falling clicks carried alone. See the note beside
        // COUNTS_PHRASED_AROUND in packages/ui.
        leader_changes: signal.leaderChanges,
      }
      switch (validation.via) {
        case 'alternation':
          return { reasonTemplateKey: 'cannibalization.fix_alternation', reasonParams }
        case 'aggregate_loss':
          return { reasonTemplateKey: 'cannibalization.fix_aggregate_loss', reasonParams }
        case 'both':
          return { reasonTemplateKey: 'cannibalization.fix_both', reasonParams }
        default: {
          const unhandled: never = validation.via
          throw new Error(`reasonFor: no sentence for cannibalization ground ${String(unhandled)}`)
        }
      }
    }

    case 'uncovered_commercial_query':
      return {
        reasonTemplateKey: signal.weakExistingTarget
          ? 'uncovered_commercial_query.create_with_link'
          : 'uncovered_commercial_query.create',
        reasonParams: { volume: signal.monthlySearchVolume ?? 0 },
      }

    case 'competitor_coverage_gap':
      // The #18 case renders the pinned Appendix A sentence (main §7.7 point
      // 3), already aliased in `packages/ui`'s renderer — reused rather than a
      // second near-identical key, exactly the drift invariant 24 exists to
      // prevent.
      return signal.ourRankingUrl
        ? { reasonTemplateKey: 'existing_target.prefer_optimize', reasonParams: {} }
        : {
            reasonTemplateKey: 'competitor_coverage_gap.create',
            reasonParams: {
              competitors: signal.competitorsRanking.length,
              best_competitor_position: signal.competitorsRanking[0]?.position ?? 0,
            },
          }

    case 'product_family_coverage_gap':
      return {
        reasonTemplateKey: 'product_family_coverage_gap.create',
        reasonParams: {
          family: signal.familyName,
          revenue_share: Math.round(signal.revenueShare * 100),
        },
      }

    case 'catalog_richness_gap':
      // The pinned copy this alias already resolves to ("We held this topic
      // back because...") is exactly this opportunity's own why, not only its
      // precondition's — so the two share one key rather than two near-copies.
      return { reasonTemplateKey: 'quality_rejection.insufficient_richness', reasonParams: {} }

    case 'missing_or_weak_metadata':
      return {
        reasonTemplateKey: 'missing_or_weak_metadata.optimize',
        reasonParams: {
          missing_fields: signal.missingFields.length,
          duplicate_fields: signal.duplicateFields.length,
        },
      }

    case 'existing_page_intent_gap':
      return {
        reasonTemplateKey: 'existing_page_intent_gap.optimize',
        reasonParams: { position: signal.position, missing_subtopics: signal.missingSubtopics.length },
      }

    case 'indexing_issue':
      // Two different problems with two different remedies: a page Google has
      // not indexed at all, and a page Google is folding into another of the
      // merchant's own. The machine word that tells them apart is not
      // something to print, so it picks the sentence instead of filling one.
      switch (signal.reason) {
        case 'not_indexed':
          return { reasonTemplateKey: 'indexing_issue.fix_not_indexed', reasonParams: {} }
        case 'canonical_mismatch':
          return { reasonTemplateKey: 'indexing_issue.fix_canonical', reasonParams: {} }
        default: {
          const unhandled: never = signal.reason
          throw new Error(`reasonFor: no sentence for indexing reason ${String(unhandled)}`)
        }
      }

    default: {
      const exhaustive: never = signal
      throw new Error(`reasonFor: no branch for signal ${JSON.stringify(exhaustive)}`)
    }
  }
}
