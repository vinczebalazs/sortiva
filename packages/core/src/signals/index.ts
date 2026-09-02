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
