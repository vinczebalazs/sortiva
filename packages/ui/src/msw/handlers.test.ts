import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setupServer } from 'msw/node'
import { ROUTES, routeKey, type RouteDefinition } from '@sortiva/core'
import { apiHandlers } from './handlers'
import { RESPONSE_FIXTURES, fixtureFor } from './fixtures'

/**
 * T0.7 done-when: "every contract has a double + fixture" and "MSW mock server
 * boots the UI shell".
 *
 * The UI shell itself is Lane F's (M9.1), so what is provable today is the
 * stronger half of that claim: a mock server built from the contract answers
 * every route, and every answer validates against the route's own response
 * schema. A frontend built against these mocks therefore cannot be built
 * against a shape the API will not produce.
 */

const BASE = 'http://localhost:3000'
const server = setupServer(...apiHandlers({ baseUrl: BASE }))

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

/** A path with its parameters filled in, so the request actually matches. */
function requestPath(route: RouteDefinition): string {
  return route.path.replace(/\{[^}]+\}/g, 'fixture-id')
}

async function call(route: RouteDefinition): Promise<Response> {
  return fetch(`${BASE}${requestPath(route)}`, {
    method: route.method,
    ...(route.body ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
  })
}

describe('MSW handlers', () => {
  it('covers every route in the contract', () => {
    const missing = ROUTES.filter((r) => !(routeKey(r) in RESPONSE_FIXTURES))
    expect(missing.map(routeKey)).toEqual([])
    expect(apiHandlers()).toHaveLength(ROUTES.length)
  })

  it.each(ROUTES.map((route) => [routeKey(route), route] as const))(
    '%s answers with a body its own response schema accepts',
    async (_key, route) => {
      const response = await call(route)
      expect(response.status).toBe(route.status ?? 200)

      const parsed = route.response.safeParse(await response.json())
      // Reporting the issues rather than a bare `false` is what makes a failing
      // fixture actionable instead of a puzzle.
      expect(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([])
    },
  )

  it('can be told to answer 409 so the frontend can build its conflict toasts', async () => {
    const route = ROUTES.find((r) => r.path === '/api/domain/claim')!
    server.use(
      ...apiHandlers({
        baseUrl: BASE,
        conflicts: { [routeKey(route)]: 'domain_already_claimed' },
      }),
    )

    const response = await call(route)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'domain_already_claimed' } })
  })

  it('can be told to answer 401 for the unauthenticated shell', async () => {
    const route = ROUTES.find((r) => r.path === '/api/account')!
    server.use(...apiHandlers({ baseUrl: BASE, unauthenticated: [routeKey(route)] }))

    const response = await call(route)
    expect(response.status).toBe(401)
  })

  it('names the route when a fixture is missing, rather than serving undefined', () => {
    expect(() => fixtureFor({ method: 'GET', path: '/api/nope' })).toThrow(/No MSW fixture/)
  })
})
