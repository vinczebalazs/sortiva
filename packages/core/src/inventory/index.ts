export {
  canonicalStoreUrl,
  extractHeadings,
  extractInternalLinks,
  normaliseOrigin,
} from './html'

export { contentChecksum, storeUrlFor, toStorePageRow, type InventoryRowInput } from './pages'

export {
  catalogEventsToTargets,
  type CatalogEventFanout,
  type InventoryTarget,
} from './events'

export {
  syncInventoryBatch,
  syncInventoryRecords,
  type InventorySyncDeps,
  type InventorySyncResult,
} from './sync'

export type {
  FamilyLookup,
  InventoryCursor,
  StoreContentBatch,
  StoreContentKind,
  StoreContentRecord,
  StoreContentSource,
  StorePageRow,
  StorePageWriter,
} from './ports'
