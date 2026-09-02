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
