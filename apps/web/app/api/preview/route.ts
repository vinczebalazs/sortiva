import { makePreviewHandler } from './_lib/handler'

/**
 * main §3.2, tech §3 — the product's only unauthenticated endpoint. Public by
 * design; Turnstile, the per-IP rate limits and the 7-day cache are what stand
 * in for a session.
 */
export const dynamic = 'force-dynamic'

export const POST = makePreviewHandler()
