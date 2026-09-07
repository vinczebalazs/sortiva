export {
  INVENTORY_CATALOG_EVENTS_TASK,
  INVENTORY_SYNC_TASK,
  enqueueCatalogEventDrain,
  enqueueInventorySync,
  type CatalogEventDrainPayload,
  type InventorySyncPayload,
  type InventorySyncTarget,
} from './queue'

export {
  drainCatalogEvents,
  registerCatalogEventTasks,
  resetCatalogEventTaskRegistration,
  type CatalogEventDrainDeps,
  type CatalogEventDrainResult,
} from './drain'

export {
  closeSuggestionsForGonePages,
  type CloseGoneSuggestionsDeps,
  type CloseGoneSuggestionsResult,
} from './gone-suggestions'

export {
  ShopifyInventorySource,
  type ShopifyInventorySourceOptions,
} from './source'

export {
  registerInventoryTasks,
  resetInventoryTaskRegistration,
  runInventorySync,
  sweepInventory,
  type InventorySyncStatus,
} from './tasks'

export type {
  InventoryConnectionStore,
  InventoryTaskDeps,
  ShopifyAdminReader,
  ShopifyCredentials,
} from './deps'
