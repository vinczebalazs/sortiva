export {
  annotateProperties,
  parseGscProperty,
  propertyMatchesClaimedDomain,
  type GscPropertyChoice,
  type GscPropertyKind,
  type ParsedGscProperty,
} from './property'

export {
  isLimitedIntelligence,
  searchConsoleConnectionState,
  type GscConnectionRow,
  type SearchConsoleConnectionState,
} from './connection'

export {
  backfillRanges,
  dailySyncRange,
  latestReportableDate,
  nextRange,
  rangeKey,
  toIsoDate,
  type BackfillCheckpoint,
  type BackfillPlanInput,
  type DateRange,
} from './windows'

export {
  GSC_NOT_GRANTED_MESSAGE,
  GSC_NO_DOMAIN_MESSAGE,
  GSC_PROPERTY_REQUIRED_MESSAGE,
  gscPropertyMismatchHint,
  gscPropertyMismatchMessage,
} from './copy'

export {
  GSC_CONNECTED_EVENT,
  chooseGscProperty,
  completeGscGrant,
  decodeGscTokens,
  encodeGscTokens,
  listGscProperties,
  skipGscConnect,
  startGscConnect,
  type ChooseGscPropertyResult,
  type GscConnectDeps,
  type GscConnectionRecord,
  type GscConnectStore,
  type GscPropertiesResult,
  type GscTokenCodec,
} from './connect'

export {
  toPageDailyRows,
  toQueryDailyRows,
  type PageDailyRow,
  type QueryDailyRow,
} from './rows'

export { brandTokens, isBrandedQuery, type BrandTokenSources } from './branded'

export {
  expectedCtrAt,
  fitCtrCurve,
  standardCurve,
  type CtrCurve,
  type CtrCurveFallbackReason,
  type CtrCurveFit,
  type CtrCurveSource,
  type CtrSampleRow,
  type FitCtrCurveInput,
} from './ctr-curve'

export {
  buildQueryClusters,
  clusterKeyFor,
  contentTokens,
  normaliseQuery,
  type BuildQueryClustersInput,
  type ClusterDraft,
  type ClusterQueryInput,
} from './clusters'

export {
  pageClusterShares,
  type ClusterDefinition,
  type ClusterShareRow,
  type ClusterShares,
  type PageShare,
} from './shares'
