import { makePreviewHandler } from './_lib/handler'

/**
 * The product's only unauthenticated endpoint. Public by design; the bot
 * challenge, the per-IP rate limits and the 7-day cache are what stand in for
 * a session.
 */
export const dynamic = 'force-dynamic'

export const POST = makePreviewHandler()
