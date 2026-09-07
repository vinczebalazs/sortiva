export { topicFingerprint } from './fingerprint'
export { topicWhyLine, type TopicWhyInput, type TopicWhyOpportunity } from './why-line'
export {
  VETOABLE_STATES,
  VETO_CONFLICT_CODE,
  PIN_CONFLICT_CODE,
  isVetoable,
  isMovable,
  isPinnable,
  moveConflictCodeFor,
  type VetoableState,
} from './transitions'
export {
  CalendarHorizonExceededError,
  pickOpenDate,
  earliestSchedulableDate,
  planMove,
  planPin,
  type OccupantTopic,
  type MovePlan,
  type PinPlan,
} from './placement'
export { excludeNotInterested } from './replenishment-guard'
export {
  scoreCandidate,
  planBatch,
  whyLineFor,
  refreshCapFor,
  explorationReserveFor,
  plannedHorizonDays,
  needsReplenishment,
  openDatesInRange,
  REPLENISHMENT_WHY_EXPLORATION,
  REPLENISHMENT_WHY_WINNING_PATTERN,
  REPLENISHMENT_WHY_REFRESH_POSITION,
  REPLENISHMENT_WHY_COMPETITOR,
  type ActivePattern,
  type BatchPick,
  type BatchPlan,
  type BatchShares,
  type CandidateDimension,
  type PatternScoringConfig,
  type ReplenishmentCandidate,
  type ScoringRecord,
  type TemplatedWhyLine,
} from './replenishment'
export {
  MERCHANT_REQUEST_BLOCKERS,
  isRefreshCandidate,
  merchantRefreshBlockers,
  rankRefreshCandidates,
  refreshBlockers,
  refreshExpectedGain,
  withinRefreshCooldown,
  type RefreshBlocker,
  type RefreshCandidateFacts,
  type RefreshEligibilityConfig,
  type RefreshRanking,
} from './refresh'
