import { describe, expect, it } from 'vitest'
import type { AdapterUser } from 'next-auth/adapters'
import { buildAuthAdapter, type AuthUserStore, type VerificationTokenStore } from './adapter'
import { buildAuthConfig, SIGN_IN_LINK_MAX_AGE_SECONDS } from './config'
import { authDeps } from './provisioning'

/**
 * Email sign-in is optional in the shape `buildAuthConfig` takes — tests that
 * only drive the callbacks leave it out — and an optional wiring is a wiring
 * that can be quietly dropped. These pin the one production call site, so
 * removing it takes the sign-in route off the screen *and* turns this red.
 */

describe('the production sign-in configuration', () => {
  it('offers a link as well as Google', () => {
    const config = buildAuthConfig(authDeps())
    const ids = config.providers.map((p) => (typeof p === 'function' ? p() : p).id)

    expect(ids).toContain('email')
    expect(ids).toContain('google')
  })

  it('has somewhere to keep an outstanding link', () => {
    expect(buildAuthConfig(authDeps()).adapter).toBeDefined()
  })

  it('expires a link in minutes, not the library default of a day', () => {
    const config = buildAuthConfig(authDeps())
    const email = config.providers
      .map((p) => (typeof p === 'function' ? p() : p))
      .find((p) => p.id === 'email') as { maxAge?: number }

    expect(email.maxAge).toBe(SIGN_IN_LINK_MAX_AGE_SECONDS)
    expect(SIGN_IN_LINK_MAX_AGE_SECONDS).toBeLessThan(60 * 60)
  })
})

function adapterOver(existing: Array<{ id: string; email: string }> = []) {
  const created: { email: string; provider: string }[] = []
  const rows = [...existing]

  const tokens: VerificationTokenStore = {
    async create() {},
    async use() {
      return undefined
    },
  }
  const users: AuthUserStore = {
    async findByEmail(email) {
      return rows.find((r) => r.email === email)
    },
    async findById(id) {
      return rows.find((r) => r.id === id)
    },
  }

  const adapter = buildAuthAdapter({
    tokens,
    users,
    provisioning: {
      store: {
        async createOrFindByEmail(email) {
          const found = rows.find((r) => r.email === email)
          if (found) return { accountId: found.id, created: false }
          const row = { id: `acct_${rows.length + 1}`, email }
          rows.push(row)
          return { accountId: row.id, created: true }
        },
      },
      capture: {
        capture(event) {
          if (event.event === 'signup_completed') {
            created.push({
              email: '',
              provider: String((event.properties ?? {}).provider),
            })
          }
        },
      },
    },
  })

  return { adapter, created, rows }
}

describe('what the sign-in adapter records', () => {
  it('calls a signup a link signup when we proved the address ourselves', async () => {
    const { adapter, created } = adapterOver()

    await adapter.createUser!({
      email: 'founder@example.com',
      emailVerified: new Date(),
    } as AdapterUser)

    expect(created.map((c) => c.provider)).toEqual(['email'])
  })

  it('calls it an OAuth signup when an identity provider asserted the address', async () => {
    const { adapter, created } = adapterOver()

    await adapter.createUser!({ email: 'founder@example.com', emailVerified: null } as AdapterUser)

    expect(created.map((c) => c.provider)).toEqual(['oauth'])
  })

  it('lowercases the address, so one person is never two accounts', async () => {
    const { adapter, rows } = adapterOver()

    const first = await adapter.createUser!({
      email: 'Founder@Example.com',
      emailVerified: null,
    } as AdapterUser)
    const again = await adapter.getUserByEmail!('FOUNDER@example.com  ')

    expect(again?.id).toBe(first.id)
    expect(rows).toHaveLength(1)
  })

  it('never claims to recognise a Google identity, so matching falls to the address', async () => {
    const { adapter } = adapterOver([{ id: 'acct_1', email: 'founder@example.com' }])

    expect(
      await adapter.getUserByAccount!({ provider: 'google', providerAccountId: '11223344' }),
    ).toBeNull()
    expect((await adapter.getUserByEmail!('founder@example.com'))?.id).toBe('acct_1')
  })

  it('leaves the account alone when asked to stamp the address as verified', async () => {
    const { adapter, rows } = adapterOver([{ id: 'acct_1', email: 'founder@example.com' }])

    const updated = await adapter.updateUser!({ id: 'acct_1', emailVerified: new Date() })

    expect(updated.email).toBe('founder@example.com')
    expect(rows).toEqual([{ id: 'acct_1', email: 'founder@example.com' }])
  })
})
