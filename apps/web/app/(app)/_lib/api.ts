import { headers } from 'next/headers'

/**
 * How an authenticated screen reads its own API while it is being rendered on
 * the server.
 *
 * Screens go through our HTTP routes rather than the database, so the same
 * component renders unchanged against the mock server it was built on and
 * against the real endpoints as they land. That means carrying the merchant's
 * cookie forward by hand — a server-side fetch has no browser to do it — and
 * building an absolute address, because there is no page to be relative to.
 *
 * Nothing here throws. A screen that dies because one of its reads was slow is
 * worse than a screen that renders what it does know, so a failure is a null
 * and the caller decides what that means.
 */

export interface RequestContext {
  readonly cookie: string
  readonly origin: string
  readonly acceptLanguage: string | null
}

export async function requestContext(): Promise<RequestContext> {
  const headerList = await headers()
  const host = headerList.get('host') ?? 'localhost:3000'
  const protocol = headerList.get('x-forwarded-proto') ?? 'http'

  return {
    cookie: headerList.get('cookie') ?? '',
    origin: `${protocol}://${host}`,
    acceptLanguage: headerList.get('accept-language'),
  }
}

export type JsonLoader = <T>(path: string, request: RequestContext) => Promise<T | null>

export const getJson: JsonLoader = async <T,>(path: string, request: RequestContext) => {
  try {
    const response = await fetch(new URL(path, request.origin), {
      headers: request.cookie ? { cookie: request.cookie } : {},
      cache: 'no-store',
    })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}
