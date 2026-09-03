import type { DetectedSignal } from './action-selection'

/**
 * The concrete units of work an opportunity decomposes into — main §7.5 step
 * 6's "deterministic for FIX/HOLD, templated from evidence". Unlike the
 * opportunity's own why-line, `opportunity_tasks.description` (schema wave 2)
 * is a plain text column with no companion template-key: the schema, not this
 * card, made that shape. So a task's words are composed here, once, from the
 * evidence a detector already measured — never by a model, and never
 * re-composed at display time the way the why-line is. See DECISIONS for the
 * copy-externalisation question this raises.
 *
 * A task this early is a *draft*: no id, no opportunity to hang off yet. The
 * repository stamps both when it writes the row.
 */

export interface OpportunityTaskDraft {
  readonly kind:
    | 'title_rewrite'
    | 'meta_rewrite'
    | 'add_section'
    | 'add_faq'
    | 'internal_links'
    | 'product_data'
    | 'consolidate'
    | 'primary_url'
    | 'canonical_recommendation'
    | 'schedule_topic'
    | 'repair_reference'
  readonly description: string
}

/** Our own articles never take the recommendation path (main §10.5) — one task, standing for "enters the refresh pipeline". */
function refreshOursTask(): OpportunityTaskDraft[] {
  return [
    {
      kind: 'schedule_topic',
      description: 'Insert a refresh topic into the calendar and rewrite this article through the full pipeline.',
    },
  ]
}

export function generateTasks(signal: DetectedSignal): readonly OpportunityTaskDraft[] {
  switch (signal.signalType) {
    case 'striking_distance': {
      if (signal.pageType === 'article_ours') return refreshOursTask()
      return [
        {
          kind: 'title_rewrite',
          description: `Rewrite the title for "${signal.clusterHead}" — the page already ranks at position ${signal.position.toFixed(1)}.`,
        },
        {
          kind: 'add_section',
          description: 'Add a buying-criteria section covering what a shopper decides on before buying.',
        },
        {
          kind: 'internal_links',
          description: 'Add internal links from related pages to strengthen this one.',
        },
      ]
    }

    case 'low_ctr_at_strong_rank':
      return [
        {
          kind: 'title_rewrite',
          description: `Rewrite the title for "${signal.clusterHead}" — it ranks at position ${signal.position.toFixed(1)} but earns ${Math.round(signal.ctrRatio * 100)}% of the store's usual click rate there.`,
        },
        { kind: 'meta_rewrite', description: 'Rewrite the meta description to better match what searchers expect.' },
      ]

    case 'content_decay': {
      if (signal.pageType === 'article_ours') return refreshOursTask()
      return [
        {
          kind: 'add_section',
          description: `Update this page — it moved from position ${signal.baselinePosition.toFixed(1)} to ${signal.currentPosition.toFixed(1)} and clicks fell from ${signal.baselineClicks} to ${signal.currentClicks}.`,
        },
        { kind: 'internal_links', description: 'Refresh internal links pointing at this page.' },
      ]
    }

    case 'cannibalization':
      return [
        {
          kind: 'primary_url',
          description: `Designate one of these ${signal.competing.length} pages as the primary target for "${signal.clusterHead}".`,
        },
        { kind: 'internal_links', description: 'Realign internal links to point at the designated primary page.' },
        { kind: 'consolidate', description: 'Consider consolidating the competing pages into the primary one.' },
      ]

    case 'uncovered_commercial_query': {
      const tasks: OpportunityTaskDraft[] = [
        {
          kind: 'schedule_topic',
          description: `Schedule a new article for "${signal.keyword}" on the content calendar.`,
        },
      ]
      if (signal.weakExistingTarget) {
        tasks.push({
          kind: 'internal_links',
          description: `Link the new page to and from ${signal.weakExistingTarget}, which covers part of this already.`,
        })
      }
      return tasks
    }

    case 'competitor_coverage_gap': {
      if (signal.ourRankingUrl) {
        return [
          {
            kind: 'title_rewrite',
            description: `Improve ${signal.ourRankingUrl} — competitors rank for "${signal.keyword}" and this page sits at position ${signal.ourPosition}.`,
          },
          { kind: 'internal_links', description: 'Add internal links to strengthen this page for the search.' },
        ]
      }
      return [
        {
          kind: 'schedule_topic',
          description: `Schedule a new article for "${signal.keyword}" — ${signal.competitorsRanking.length} competitors already rank for it.`,
        },
      ]
    }

    case 'product_family_coverage_gap':
      return [
        {
          kind: 'schedule_topic',
          description: `Schedule coverage for ${signal.familyName}, which earns ${Math.round(signal.revenueShare * 100)}% of trailing revenue with nothing written about it.`,
        },
      ]

    case 'catalog_richness_gap':
      return [
        {
          kind: 'product_data',
          description: `Add material, dimensions, use case and compatibility details for ${signal.shortfalls.length} products before this topic can proceed.`,
        },
      ]

    case 'missing_or_weak_metadata': {
      const tasks: OpportunityTaskDraft[] = []
      if (signal.missingFields.includes('seo_title') || signal.duplicateFields.includes('seo_title')) {
        tasks.push({ kind: 'title_rewrite', description: 'Write a unique search title for this page.' })
      }
      if (signal.missingFields.includes('seo_description') || signal.duplicateFields.includes('seo_description')) {
        tasks.push({ kind: 'meta_rewrite', description: 'Write a unique meta description for this page.' })
      }
      return tasks
    }

    case 'existing_page_intent_gap':
      return signal.missingSubtopics.map((subtopic) => ({
        kind: 'add_section' as const,
        description: `Add a section covering "${subtopic}" — the top-ranking pages for this search cover it and ours does not.`,
      }))

    case 'indexing_issue':
      // The enum has no separate "indexing" kind; main §7.3's own row groups
      // "not indexed" and "canonical points elsewhere" under one recommendation.
      return [
        {
          kind: 'canonical_recommendation',
          description:
            signal.reason === 'canonical_mismatch'
              ? 'Google is choosing a different canonical URL than the one declared — review and align it.'
              : 'This page is not indexed — investigate why before any content work here.',
        },
      ]

    default: {
      const exhaustive: never = signal
      throw new Error(`generateTasks: no branch for signal ${JSON.stringify(exhaustive)}`)
    }
  }
}
