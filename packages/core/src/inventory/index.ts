export {
  canonicalStoreUrl,
  extractHeadings,
  extractInternalLinks,
  normaliseOrigin,
} from './html'

export { contentChecksum, storeUrlFor, toStorePageRow, type InventoryRowInput } from './pages'

export { catalogEventsToTargets, type CatalogEventFanout } from './events'

export {
  resyncInventoryTargets,
  syncInventoryBatch,
  syncInventoryRecords,
  type InventorySyncDeps,
  type InventorySyncResult,
} from './sync'

export type {
  FamilyLookup,
  InventoryTarget,
  InventoryCursor,
  StoreContentBatch,
  StoreContentKind,
  StoreContentRecord,
  StoreContentSource,
  StorePageRow,
  StorePageWriter,
} from './ports'
