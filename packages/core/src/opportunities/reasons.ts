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

    case 'cannibalization':
      return {
        reasonTemplateKey: 'cannibalization.fix',
        reasonParams: {
          competing_urls: signal.competing.length,
          leader_changes: signal.leaderChanges,
        },
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
      return {
        reasonTemplateKey: 'indexing_issue.fix',
        reasonParams: { reason: signal.reason },
      }

    default: {
      const exhaustive: never = signal
      throw new Error(`reasonFor: no branch for signal ${JSON.stringify(exhaustive)}`)
    }
  }
}
