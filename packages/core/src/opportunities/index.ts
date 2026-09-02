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
