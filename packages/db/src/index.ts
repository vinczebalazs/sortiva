export { closeDb, createPool, db, dbPool, schema, type Database, type Db } from './client'
export { PostgresRequestCache } from './cache'
export { pingDatabase } from './health'
export { PostgresCostLedger } from './spend'
export { accountScope, systemScope, type AccountScope, type SystemScope } from './scope'
export * from './schema'
export * from './repositories'
export { makeGscConnectStore, type GscConnectStoreOptions } from './stores/gsc'
export { makeNotificationStore, type NotificationStoreOptions } from './stores/notifications'

// The integration-test harness is deliberately NOT re-exported here: it pulls in
// the migrator and resolves ../migrations from disk, which has no business in an
// application bundle. Test files import it as `@sortiva/db/testing`.
export { makeEmailStore, type EmailStoreOptions } from './stores/email'
