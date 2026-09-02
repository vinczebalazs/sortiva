import { afterEach, describe, expect, it } from 'vitest'
import { MockPosthogCapture } from '@sortiva/providers'
import { initAppServices, resetAppServices } from '@sortiva/core/runtime/services'
import { withAccount } from './app/api/auth/_lib/session'
import { onRequestError } from './instrumentation'

/**
 * T-OPS: an unhandled error in a route reaches the crash reporter.
 *
 * The error is produced by a real route handler through the real `withAccount`
 * wrapper, and then handed to the hook Next calls with exactly that error —
 * which is what makes this an assertion about the call rather than about the
 * export existing.
 */

afterEach(() => {
  resetAppServices()
})

describe('an unhandled error in a route', () => {
  it('escapes the handler and is captured with the route it came from', async () => {
    const analytics = new MockPosthogCapture()
    initAppServices(() => ({ analytics }))

    const route = withAccount(
      () => {
        throw new Error('the store repository is unreachable')
      },
      async () => 'acct-42',
    )

    // Step one: the handler really does let the error out — which is the only
    // reason Next's hook ever sees it.
    const thrown = await route(new Request('https://sortiva.test/api/account'), {}).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(thrown).toBeInstanceOf(Error)

    // Step two: what Next does with it.
    await onRequestError(
      thrown,
      { path: '/api/account?tab=secret', method: 'GET' },
      { routerKind: 'App Router', routePath: '/api/account', routeType: 'route' },
    )

    expect(analytics.exceptions).toHaveLength(1)
    const [captured] = analytics.exceptions
    expect((captured!.error as Error).message).toBe('the store repository is unreachable')
    expect(captured!.capture.properties).toMatchObject({
      source: 'route',
      method: 'GET',
      route_path: '/api/account',
    })
  })

  it('does not carry the query string into the report', async () => {
    const analytics = new MockPosthogCapture()
    initAppServices(() => ({ analytics }))

    await onRequestError(new Error('boom'), { path: '/api/preview?domain=nike.com', method: 'POST' })

    expect(analytics.exceptions[0]!.capture.properties.path).toBe('/api/preview')
    expect(JSON.stringify(analytics.exceptions[0]!.capture.properties)).not.toContain('nike.com')
  })

  it('does not throw when the process has no analytics client', async () => {
    await expect(onRequestError(new Error('early'), { path: '/api/health' })).resolves.toBeUndefined()
  })
})
