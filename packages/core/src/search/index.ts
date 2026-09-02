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
  toPageDailyRows,
  toQueryDailyRows,
  type PageDailyRow,
  type QueryDailyRow,
} from './rows'
