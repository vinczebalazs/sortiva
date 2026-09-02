import { handleUnsubscribe } from './handler'

/**
 * The one-click unsubscribe endpoint. Unauthenticated because the bulk-sender
 * rules require it to work in a single request with no sign-in; the link's
 * signature is what stands in for a session.
 */
export const dynamic = 'force-dynamic'

export const GET = (request: Request) => handleUnsubscribe(request)
export const POST = (request: Request) => handleUnsubscribe(request)
