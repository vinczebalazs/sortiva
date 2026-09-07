export {
  COVERAGE_RESPONSE_SCHEMA,
  analyseCoverage,
  buildCoverageRequest,
  gapSet,
  groundSubtopics,
  type AnalyseCoverageDeps,
  type CoverageAnalysis,
  type CoverageAnalysisInput,
  type CoverageAnalysisOutput,
  type CoverageCompetitorPage,
  type CoveragePage,
  type CoveragePrompt,
  type SubtopicCitation,
  type SubtopicCoverage,
} from './coverage'
export {
  COVERAGE_ANALYSIS_SOURCE,
  buildIntentGapSignal,
  shortlistIntentGapPages,
  type BuildIntentGapSignalInput,
  type IntentGapCandidate,
  type ShortlistIntentGapInput,
} from './intent-gap'
export {
  detectApplied,
  type AppliedDetection,
  type AppliedSignal,
  type CurrentPageState,
} from './applied'
export {
  OPTIMIZE_JUDGE_CRITERIA,
  evaluateOptimizeFloors,
  gradeRecommendation,
  gradingEvidence,
  type OptimizeCriterionOutcome,
  type OptimizeGradeResult,
  type OptimizeJudgeCriterion,
} from './grading'
export {
  lintMessages,
  lintRecommendation,
  type OptimizeLintCheck,
  type OptimizeLintIssue,
  type OptimizeLintResult,
} from './lints'
export {
  packFactAddresses,
  packFacts,
  packLinkAddresses,
  type CitableField,
  type OptimizeEvidencePack,
  type OptimizePackFamily,
  type OptimizePackLinkCandidate,
  type OptimizePackPage,
  type OptimizePackPersona,
  type OptimizePackProduct,
  type OptimizePackQuery,
  type OptimizePackRankingPage,
  type PackFact,
} from './pack'
export {
  RECOMMENDATION_RESPONSE_SCHEMA,
  buildRecommendationRequest,
  fieldRationale,
  generateRecommendation,
  type BuildRecommendationInput,
  type GenerateRecommendationDeps,
  type GeneratedRecommendation,
  type OptimizeRecommendation,
  type RecommendationFaq,
  type RecommendationField,
  type RecommendationHeading,
  type RecommendationInternalLinks,
  type RecommendationPrompt,
  type RecommendationSection,
} from './recommendation'
// The drawer's narrower names — `toDrawerRecommendation` and its constants —
// are published by the opportunities barrel instead, so the package's single
// top-level barrel never sees one name arriving from two places.
export {
  isFailedRecommendation,
  toRecommendationView,
  type RecommendationView,
  type RecommendationViewFaq,
  type RecommendationViewField,
  type RecommendationViewReason,
  type RecommendationViewSection,
} from './recommendation-view'
export {
  resolveTargetQueryFromClusters,
  targetQueryFromEvidence,
  type ResolveTargetQueryInput,
} from './target-query'
export {
  renderRecommendationHtml,
  renderRecommendationMarkdown,
  type RecommendationLabels,
  type RenderRecommendationInput,
} from './render'
