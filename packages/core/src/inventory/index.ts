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
  ArticleAddressMove,
  FamilyLookup,
  InventoryTarget,
  InventoryCursor,
  OurArticleAddressWriter,
  OurArticleLookup,
  PublishedArticleAddress,
  ShopArticleOfOurs,
  StoreContentBatch,
  StoreContentKind,
  StoreContentRecord,
  StoreContentSource,
  StorePageRow,
  StorePageWriter,
} from './ports'
