import { HttpResponse, http, type HttpHandler } from 'msw'
import { ROUTES, type ConflictCode, type RouteDefinition } from '@sortiva/core'
import { fixtureFor } from './fixtures'

/**
 * MSW handlers for every route in the contract. Lane F builds screens against
 * these before the backend cards land.
 *
 * They are generated from the route table rather than written by hand, so a
 * route added to the contract cannot be missing a mock, and a mock cannot
 * describe a path the API does not serve.
 */

/** MSW matches `:param`; OpenAPI writes `{param}`. */
function toMswPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1')
}

export interface HandlerOptions {
  /** Prefix for absolute URLs; omit for same-origin requests. */
  baseUrl?: string
  /**
   * Force a route to answer with a conflict, so the frontend can build its
   * state-conflict toasts without waiting for a real race.
   */
  conflicts?: Partial<Record<string, ConflictCode>>
  /** Force a route to answer 401, for the unauthenticated shell. */
  unauthenticated?: readonly string[]
}

function handlerFor(route: RouteDefinition, options: HandlerOptions): HttpHandler {
  const key = `${route.method} ${route.path}`
  const url = `${options.baseUrl ?? ''}${toMswPath(route.path)}`
  const method = route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete'

  return http[method](url, () => {
    if (options.unauthenticated?.includes(key)) {
      return HttpResponse.json(
        { error: { code: 'unauthenticated', message: 'No session.' } },
        { status: 401 },
      )
    }

    const conflict = options.conflicts?.[key]
    if (conflict) {
      return HttpResponse.json(
        { error: { code: conflict, message: 'This changed while you were looking at it.' } },
        { status: 409 },
      )
    }

    return HttpResponse.json(fixtureFor(route) as Record<string, unknown>, {
      status: route.status ?? 200,
    })
  })
}

export function apiHandlers(options: HandlerOptions = {}): HttpHandler[] {
  return ROUTES.map((route) => handlerFor(route, options))
}

/** Default set, for `setupServer(...handlers)` / `setupWorker(...handlers)`. */
export const handlers: HttpHandler[] = apiHandlers()
