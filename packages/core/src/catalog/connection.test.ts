import { describe, expect, it } from 'vitest'
import { accountAttribution } from '../contracts/analytics'
import { StubNotificationEmitter } from '../contracts/doubles'
import type { DomainState } from '../account/view'
import { handleAppUninstalled, recordConnectionLost, type ConnectionLifecycleDeps } from './connection'
import type { StoreConnection } from './ports'

/**
 * What happens when a merchant uninstalls the app, or Shopify stops accepting
 * the token we hold. Both are the same event as far as we are concerned, and
 * both have to be safe to process twice — the queue delivers at least once, and
 * Shopify redelivers webhooks.
 */

const ACCOUNT = 'account-1'

function world(options: { state?: DomainState; connection?: Partial<StoreConnection> } = {}) {
  let state: DomainState = options.state ?? 'ready_for_planning'
  let connection: StoreConnection | undefined = {
    accountId: ACCOUNT,
    shopHandle: 'acme',
    grantedScopes: ['read_products'],
    connectedAt: new Date('2026-08-01T00:00:00Z'),
    invalidatedAt: null,
    ...options.connection,
  }
  const notifications = new StubNotificationEmitter()

  const deps: ConnectionLifecycleDeps = {
    notifications,
    domains: {
      async findAccountByShopHandle(handle) {
        return handle === 'acme' ? ACCOUNT : undefined
      },
      async setPlatform() {},
      async transition(_id, from, to) {
        if (!from.includes(state)) return undefined
        state = to
        return to
      },
      async read() {
        return state
      },
    },
    connections: {
      async read() {
        return connection
      },
      async markInvalid(_id, at) {
        if (connection && connection.invalidatedAt === null) {
          connection = { ...connection, invalidatedAt: at }
        }
        return connection?.invalidatedAt ?? at
      },
    },
  }

  return { deps, notifications, currentState: () => state, connection: () => connection }
}

describe('a connection that stops working', () => {
  it('asks the merchant to reconnect and pauses new work', async () => {
    const w = world()

    const result = await recordConnectionLost(w.deps, {
      accountId: ACCOUNT,
      at: new Date('2026-09-01T10:00:00Z'),
      attribution: accountAttribution(ACCOUNT, 'acme.example'),
    })

    expect(result.changed).toBe(true)
    expect(w.currentState()).toBe('awaiting_shopify_auth')
    expect(w.notifications.emitted.map((e) => e.type)).toEqual(['connection_lost_shopify'])
  })

  it('is safe to process twice, and says so the second time', async () => {
    const w = world()
    const at = new Date('2026-09-01T10:00:00Z')
    const attribution = accountAttribution(ACCOUNT, 'acme.example')

    const first = await recordConnectionLost(w.deps, { accountId: ACCOUNT, at, attribution })
    const second = await recordConnectionLost(w.deps, {
      accountId: ACCOUNT,
      at: new Date('2026-09-01T11:00:00Z'),
      attribution,
    })

    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(second.invalidatedAt.toISOString()).toBe(first.invalidatedAt.toISOString())
    expect(w.notifications.emitted).toHaveLength(1)
  })

  it('leaves a store parked as unsupported exactly where it is', async () => {
    const w = world({ state: 'unsupported' })

    await recordConnectionLost(w.deps, {
      accountId: ACCOUNT,
      at: new Date(),
      attribution: accountAttribution(ACCOUNT),
    })

    expect(w.currentState()).toBe('unsupported')
  })
})

describe('the app being uninstalled', () => {
  it('is handled exactly like a rejected token', async () => {
    const w = world()

    const result = await handleAppUninstalled(w.deps, {
      shopHandle: 'acme',
      at: new Date('2026-09-01T10:00:00Z'),
      attribution: (id) => accountAttribution(id, 'acme.example'),
    })

    expect(result?.accountId).toBe(ACCOUNT)
    expect(w.currentState()).toBe('awaiting_shopify_auth')
    expect(w.notifications.emitted).toHaveLength(1)
  })

  it('does nothing for a store nobody here has connected', async () => {
    const w = world()

    const result = await handleAppUninstalled(w.deps, {
      shopHandle: 'a-stranger',
      at: new Date(),
      attribution: (id) => accountAttribution(id),
    })

    expect(result).toBeUndefined()
    expect(w.notifications.emitted).toHaveLength(0)
    expect(w.currentState()).toBe('ready_for_planning')
  })
})
