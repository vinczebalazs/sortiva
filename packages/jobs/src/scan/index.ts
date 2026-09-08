export {
  DbExistingTargetCheck,
  existingTargetInputFor,
  type ExistingTargetDeps,
} from './existing-target'

export { DbOpportunitySource } from './opportunity-source'

export {
  refitCtrCurveForAccount,
  type CtrCurveRefitDeps,
  type CtrCurveRefitOutcome,
} from './ctr-curve'

export {
  rebuildQueryClustersForAccount,
  type ClusterRebuildDeps,
  type ClusterRebuildOutcome,
} from './clusters'

export {
  CTR_CURVE_REFIT_TASK,
  SIGNAL_SCAN_ONBOARDING_SWEEP_TASK,
  SIGNAL_SCAN_WEEKLY_TASK,
  registerScanTasks,
  registerSignalScanTasks,
  resetScanTaskRegistration,
  resetSignalScanTaskRegistration,
  runCtrCurveRefit,
  type ScanTaskDeps,
  type SignalScanTaskDeps,
} from './tasks'

export { runSignalScan, type RunSignalScanDeps, type SignalRunKind, type SignalRunOutcome } from './run'

export {
  runOnboardingScan,
  sweepOnboardingRuns,
  type OnboardingScanDeps,
  type OnboardingScanResult,
  type OnboardingSweepDeps,
} from './onboarding'

export {
  sweepWeeklyScans,
  weeklyRunId,
  type WeeklyScanDeps,
  type WeeklyScanSweepOutcome,
} from './weekly'

export { runEventDrivenScan } from './event'

export {
  readIntentGapSignals,
  type IntentGapReadDeps,
  type IntentGapReadInput,
  type IntentGapReadResult,
} from './intent-gap'
