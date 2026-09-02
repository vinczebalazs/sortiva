import { withAccount } from '../auth/_lib/session'
import { notificationsHandler } from './_lib/handlers'

/**
 * The bell, polled every thirty seconds. `?since=` is the browser's own
 * high-water mark, so a merchant with the tab open and nothing happening costs
 * one indexed read.
 *
 * Polling rather than a socket: the freshest thing in this product moves once a
 * day, so half a minute of staleness on a badge cannot be perceived, and there
 * is no realtime infrastructure to run or pay for.
 */
export const dynamic = 'force-dynamic'

export const GET = withAccount(notificationsHandler)
