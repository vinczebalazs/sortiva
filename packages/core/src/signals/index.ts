export {
  GSC_SOURCE,
  INVENTORY_SOURCE,
  earlierWindowToken,
  facts,
  indexPages,
  normalisePageUrl,
  windowToken,
  type DetectionResult,
  type DetectionWindow,
  type FactInput,
  type PageFact,
  type PageIndex,
  type StorePageType,
} from './types'

export {
  pageTotals,
  storeBaseline,
  type PageTotals,
  type StoreBaseline,
} from './baseline'

export { strongestPerPage, type PageCandidate, type StrongestPerPage } from './per-page'

export {
  detectStrikingDistance,
  type StrikingDistanceInput,
  type StrikingDistanceSignal,
} from './striking-distance'

export {
  detectLowCtrAtStrongRank,
  type LowCtrCurveInput,
  type LowCtrInput,
  type LowCtrSignal,
} from './low-ctr'

export {
  detectContentDecay,
  type ContentDecayInput,
  type ContentDecayResult,
  type ContentDecaySignal,
} from './decay'

export {
  detectCannibalization,
  type CannibalizationInput,
  type CannibalizationResult,
  type CannibalizationSignal,
  type CannibalizationValidation,
  type CompetingPage,
  type WeeklyShareRow,
} from './cannibalization'

export {
  clearsDemandFloor,
  isCommercialIntent,
  type ExistingCoverage,
  type KeywordCandidate,
} from './candidates'

export {
  substanceInventory,
  type ProductField,
  type ProductShortfall,
  type ProductSubstance,
  type SubstanceInventory,
} from './substance'

export {
  detectUncoveredCommercialQueries,
  UncheckedCandidateError,
  type UncoveredQueryInput,
  type UncoveredQuerySignal,
} from './uncovered-query'

export {
  detectCompetitorCoverageGaps,
  type CompetitorGapCandidate,
  type CompetitorGapInput,
  type CompetitorGapSignal,
  type CompetitorRanking,
} from './competitor-gap'

export {
  detectFamilyCoverageGaps,
  type FamilyCoverageCandidate,
  type FamilyCoverageGapSignal,
  type FamilyCoverageInput,
  type MappedContent,
} from './family-coverage'

export {
  detectCatalogRichnessGaps,
  type RichnessGapCandidate,
  type RichnessGapInput,
  type RichnessGapSignal,
} from './richness-gap'

export {
  detectMetadataProblems,
  type MetadataField,
  type MetadataInput,
  type MetadataPage,
  type MetadataSignal,
  type SharedMetadata,
} from './metadata'

export {
  signalRuns,
  signalsNeedingSearchConsole,
  signalsWithoutSearchConsole,
} from './limited-intelligence'

export {
  classifyKeywordIntent,
  mapKeywordToFamilies,
  type FamilyMappingCandidate,
} from './keyword-classify'
