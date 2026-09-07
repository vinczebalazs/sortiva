export { closeDb, createPool, db, dbPool, schema, type Database, type Db } from './client'
export { PostgresRequestCache } from './cache'
export { pingDatabase } from './health'
export { PostgresCostLedger } from './spend'
export { accountScope, systemScope, type AccountScope, type SystemScope } from './scope'
export * from './schema'
export * from './repositories'
export { makeFamilyStore, type FamilyStore, type FamilyStoreOptions } from './stores/families'
export { makeKeywordStore, type KeywordStore, type KeywordStoreOptions } from './stores/keywords'
export { makeGscConnectStore, type GscConnectStoreOptions } from './stores/gsc'
export {
  makeProfileStore,
  type ProfileFamily,
  type ProfileSearchConsole,
  type ProfileStore,
  type ProfileStoreOptions,
} from './stores/profile'
export {
  makeProductsStore,
  type ProductsStore,
  type ProductsStoreOptions,
} from './stores/products'
export {
  makeIngestionStatusStore,
  type IngestionRunView,
  type IngestionStatusStore,
  type IngestionStatusStoreOptions,
} from './stores/ingestion'
export { makeNotificationStore, type NotificationStoreOptions } from './stores/notifications'
export { makeEmailStore, type EmailStoreOptions } from './stores/email'
export {
  makeAccountLifecycleStore,
  type AccountLifecycleStoreOptions,
} from './stores/lifecycle'
export {
  makeWebhookEventStore,
  type WebhookEventStore,
  type WebhookEventStoreOptions,
} from './stores/webhook-events'

// The integration-test harness is deliberately NOT re-exported here: it pulls in
// the migrator and resolves ../migrations from disk, which has no business in an
// application bundle. Test files import it as `@sortiva/db/testing`.
