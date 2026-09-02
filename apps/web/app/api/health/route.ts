import { healthHandler } from './_lib/handler'

/**
 * What the platform polls to decide whether this container is worth keeping.
 *
 * It answers `{ "ok": true }` only when the database answers and the background
 * worker is running; otherwise 503, which is what makes restart-on-failure a
 * real mechanism rather than a setting.
 */
export const dynamic = 'force-dynamic'

export const GET = healthHandler
