export {
  NoCompetingPagesError,
  buildConsolidationRecommendation,
  consolidationInputFromEvidence,
  consolidationInputFromSignal,
  type CanonicalSuggestion,
  type CompetingPageFacts,
  type ConsolidationInput,
  type ConsolidationPage,
  type ConsolidationRecommendation,
  type LinkRealignment,
  type PrimaryReasonKey,
} from './consolidation'
export {
  BLOCKING_FIX_SIGNAL_TYPES,
  blockingFixesByEntity,
  blockingPreconditionsFor,
  type BlockingCandidateRow,
} from './blocking'
export {
  FIX_TRUST_LINE_KEY,
  renderConsolidationView,
  type FixRecommendationView,
  type FixSection,
  type FixSectionLine,
} from './view'
export {
  optimizeRouteFor,
  refreshPoolRequestFor,
  type OptimizeRoute,
  type RefreshPoolRequest,
} from './refresh-routing'
