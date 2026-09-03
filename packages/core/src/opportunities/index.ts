export {
  assertClearedToCreate,
  isCreateClearance,
  MissingExistingTargetCheckError,
  type CreateClearance,
  type InternalLinkTask,
} from './clearance'

export {
  existingTargetCheck,
  findExistingTarget,
  toContractOutcome,
  type ExistingTargetMatch,
  type ExistingTargetResult,
  type MatchSource,
  type MatchStrength,
  type WeaknessReason,
} from './existing-target'

export type {
  ClusterRankedPage,
  ExistingTargetConfig,
  ExistingTargetInput,
  ExistingTargetPage,
  PagePresence,
  ProxyRankedKeyword,
} from './ports'

export {
  businessWeight,
  confidenceScore,
  createOpportunityScore,
  existingPageExpectedGain,
  fallbackMagnitude,
  percentileImpact,
  type ConfidenceInput,
  type ConfidenceResult,
  type CreateScoreInput,
  type ImpactConfig,
  type ImpactResult,
} from './scoring'

export {
  selectAction,
  type ActionSelectionContext,
  type ActionSelectionResult,
  type DetectedSignal,
} from './action-selection'

export { reasonFor, type TemplatedReason } from './reasons'

export { generateTasks, type OpportunityTaskDraft } from './tasks'

export type { ExistingPageIntentGapSignal, IndexingIssueSignal } from './p1-signal-shapes'

export {
  buildOpportunityDraft,
  rankByImpact,
  type OpportunityBuildContext,
  type OpportunityDraft,
  type RankedOpportunityDraft,
} from './build'

export {
  allowedTransitionsFrom,
  assertCanTransition,
  canTransition,
  EXPIRY_REASONS,
  InvalidOpportunityTransitionError,
  reconcileStatusWithPreconditions,
  type ExpiryReason,
} from './lifecycle'

export {
  opportunityDetected,
  opportunityStatusChanged,
  signalRunCompleted,
  OPPORTUNITY_DETECTED_EVENT,
  OPPORTUNITY_STATUS_CHANGED_EVENT,
  SIGNAL_RUN_COMPLETED_EVENT,
  type OpportunityStatusActor,
  type SignalRunSummary,
} from './events'

export { toContractOpportunity, type StoredOpportunity } from './contract-mapping'
