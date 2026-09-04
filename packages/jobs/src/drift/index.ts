export {
  anyVariantAvailable,
  detectDrift,
  sectionHeadingsOf,
  type DriftInputs,
} from './detect'

export {
  mendArticleReferences,
  settlePendingRepairs,
  type RepairExecutionDeps,
  type RepairMendInput,
  type SettleResult,
} from './repair'

export {
  runDriftPassForAccount,
  DRIFT_PASS_EVENT,
  type DriftPassResult,
  type DriftSweepDeps,
  type PlannedSwap,
} from './sweep'

export {
  enqueueDriftPass,
  registerDriftTasks,
  resetDriftTaskRegistration,
  sweepDrift,
  DRIFT_ACCOUNT_TASK,
  DRIFT_SWEEP_TASK,
  type DriftPassPayload,
  type DriftTaskDeps,
} from './tasks'
