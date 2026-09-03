import type { EvidenceFact } from '../contracts/opportunities'
import type { StorePageType } from '../signals/types'

/**
 * Two shapes with no detector behind them yet.
 *
 * `existing_page_intent_gap`'s detection is the subtopic-coverage analysis of
 * main §10.3 — one Sonnet call over a page and its top-5 SERP competitors —
 * which is Lane E's OPTIMIZE pipeline (`T6.2`), not this card's. `indexing_issue`
 * needs the URL Inspection API (main §12.4, P1, "not required for launch") and
 * has no detector anywhere in the plan yet. Both are still real signal types —
 * they are in the V1 taxonomy (main §7.3), the `signal_type` database enum, and
 * two of the eight worked examples this card's done-when names.
 *
 * So the opportunity engine has to know these shapes exist and be able to turn
 * one into an opportunity, even though nothing produces one today. These types
 * are that contract, kept intentionally thin — exactly the evidence each
 * worked example states and nothing a real detector would eventually add on
 * its own judgement. Whoever builds the real detector should feel free to
 * replace this file's export with a richer one; the scoring, action-selection
 * and task code downstream only reads the fields named here.
 */

export interface ExistingPageIntentGapSignal {
  readonly signalType: 'existing_page_intent_gap'
  readonly page: string
  readonly pageType: StorePageType
  readonly clusterHead: string
  readonly position: number
  /** What the page was shown for in the window — the scoring input §9.6.5 needs; no formula is stated for this signal, so this is what a fallback magnitude reads. */
  readonly clusterImpressions: number
  /** Subtopics the top-5 SERP pages cover that ours does not — main §10.3's gap set. */
  readonly missingSubtopics: readonly string[]
  readonly evidence: readonly EvidenceFact[]
}

export interface IndexingIssueSignal {
  readonly signalType: 'indexing_issue'
  readonly page: string
  readonly pageType: StorePageType
  readonly reason: 'not_indexed' | 'canonical_mismatch'
  readonly evidence: readonly EvidenceFact[]
}
