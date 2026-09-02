import { withAccount } from '../auth/_lib/session'
import { attentionHandler } from '../notifications/_lib/handlers'

/**
 * The dashboard's "needs you" list, computed fresh on every request.
 *
 * Nothing here is stored, so there is no way for an item to outlive the thing
 * it is about: approving the draft, applying the task or confirming the URL
 * makes the underlying condition false and the item is simply not there next
 * time. That is the entire mechanism — no "mark as done", nothing to clear.
 */
export const dynamic = 'force-dynamic'

export const GET = withAccount(attentionHandler)
