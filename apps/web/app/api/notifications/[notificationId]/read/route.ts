import { withAccount } from '../../../auth/_lib/session'
import { notificationReadHandler } from '../../_lib/handlers'

/** Clicking one item. */
export const dynamic = 'force-dynamic'

export const POST = withAccount(notificationReadHandler)
