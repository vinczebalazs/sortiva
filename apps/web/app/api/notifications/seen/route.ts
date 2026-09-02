import { withAccount } from '../../auth/_lib/session'
import { notificationsSeenHandler } from '../_lib/handlers'

/**
 * Opening the bell clears the badge. Seen is not read: the merchant now knows
 * the items are there, which is a different claim from having looked at one.
 */
export const dynamic = 'force-dynamic'

export const POST = withAccount(notificationsSeenHandler)
