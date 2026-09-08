import type { ServerResponse } from 'node:http'
import { ROUTES } from '@sortiva/core'

/**
 * How the stand-in server decides which of its answers a request wants — and
 * refuses, at start-up, to answer an address the product does not have.
 *
 * The browser flows run against a server built beside the screens, and for the
 * whole of the project's life that server also *invented* addresses: the
 * Opportunities screen posted to three paths nobody had ever built, this file's
 * predecessor implemented all three by hand, and every flow passed. A screen
 * checked against a server built to agree with it is checked against nothing.
 *
 * So every answer here is declared with the address as the contract spells it,
 * and `declare` looks that address up in the route table. A typo, a guess, or a
 * route that has moved fails the whole suite before the first page loads,
 * naming the address — which is the failure that was missing.
 */

export interface MockRequest {
  /** The path parameters, in the order the address names them. */
  readonly params: readonly string[]
  readonly body: string
  readonly query: URLSearchParams
}

/**
 * Answers the request, or returns `false` to decline it — a few addresses only
 * answer from run state while a flow is part-way through, and otherwise want
 * the ordinary frozen fixture the merchant's own screens are built against.
 */
export type MockHandler = (
  response: ServerResponse,
  request: MockRequest,
) => boolean | Promise<boolean>

export interface MockRoute {
  readonly method: string
  readonly path: string
  readonly pattern: RegExp
  readonly handler: MockHandler
}

/** The address as a matcher: `/api/opportunities/{id}` matches one path segment. */
function patternFor(path: string): RegExp {
  const source = path
    .split(/\{[^}]+\}/)
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('([^/]+)')
  return new RegExp(`^${source}$`)
}

/**
 * An answer for a route the product actually serves.
 *
 * The path is the contract's own spelling, parameters and all, so it can be
 * compared to the table rather than to a regex somebody wrote from memory.
 */
export function declare(method: string, path: string, handler: MockHandler): MockRoute {
  const known = ROUTES.some((route) => route.method === method && route.path === path)
  if (!known) {
    throw new Error(
      `the mock server answers ${method} ${path}, which the route table does not declare — ` +
        'either the address is wrong or the route is not in the contract; a stand-in server ' +
        'must never invent an address the product does not have',
    )
  }
  return { method, path, pattern: patternFor(path), handler }
}

/**
 * The prefix reserved for the flows' own control surface — resetting state
 * between runs, reading back what the screens sent, standing in for a vendor's
 * redirect. These are test scaffolding and deliberately outside the contract,
 * which is why they are spelled out here rather than being an exception
 * anybody can take.
 */
export const SCAFFOLDING_PREFIX = '/api/_e2e/'

export function scaffolding(method: string, path: string, handler: MockHandler): MockRoute {
  if (!path.startsWith(SCAFFOLDING_PREFIX)) {
    throw new Error(
      `${method} ${path} is not declared in the route table and is not under ` +
        `${SCAFFOLDING_PREFIX}; test scaffolding lives under that prefix so it can never be ` +
        'mistaken for a product address',
    )
  }
  return { method, path, pattern: patternFor(path), handler }
}

/** The first declared answer whose address matches, in declaration order. */
export function match(
  routes: readonly MockRoute[],
  method: string,
  pathname: string,
): { route: MockRoute; params: readonly string[] } | null {
  for (const route of routes) {
    if (route.method !== method) continue
    const found = route.pattern.exec(pathname)
    if (found) return { route, params: found.slice(1) }
  }
  return null
}
