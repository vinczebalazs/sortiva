import { describe, expect, it } from 'vitest'
import type { AccountStore } from '@sortiva/core'
import { ACCOUNT_ID_CLAIM, buildAuthConfig } from './config'

/**
 * main §4.1 and tech §3 — a session exists only once it names an account, and
 * that is the only place a request learns its `account_id`. These drive the
 * real Auth.js callbacks; the account store is in memory.
 */

function store(): AccountStore & { calls: string[] } {
  const calls: string[] = []
  const byEmail = new Map<string, string>()
  return {
    calls,
    async createOrFindByEmail(email: string) {
      calls.push(email)
      const existing = byEmail.get(email)
      if (existing) return { accountId: existing, created: false }
      const accountId = `acct_${byEmail.size + 1}`
      byEmail.set(email, accountId)
      return { accountId, created: true }
    },
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function callbacks(accountStore: AccountStore) {
  return buildAuthConfig({ provisioning: { store: accountStore } }).callbacks as any
}

describe('Auth.js configuration (main §4.1, tech §3)', () => {
  it('sessions are JWTs and last a day, because they cannot be revoked', () => {
    const config = buildAuthConfig({ provisioning: { store: store() } })
    expect(config.session?.strategy).toBe('jwt')
    expect(config.session?.maxAge).toBe(60 * 60 * 24)
  })

  it('requests identity scopes only — Search Console is a separate consent (invariant 21)', () => {
    const config = buildAuthConfig({ provisioning: { store: store() } })
    const google = config.providers[0] as any
    const scope: string = google.options.authorization.params.scope
    expect(scope).toBe('openid email profile')
    expect(scope).not.toMatch(/webmasters|googleapis/)
  })

  it('provisions the account on sign-in and puts its id on the session', async () => {
    const accountStore = store()
    const cb = callbacks(accountStore)

    const token = await cb.jwt({
      token: {},
      user: { email: 'founder@example.com' },
      account: { provider: 'google' },
    })
    expect(token[ACCOUNT_ID_CLAIM]).toBe('acct_1')

    const session = cb.session({ session: { user: {} }, token })
    expect(session.user.id).toBe('acct_1')
  })

  it('does not re-provision on a session refresh', async () => {
    const accountStore = store()
    const cb = callbacks(accountStore)

    const token = await cb.jwt({ token: {}, user: { email: 'founder@example.com' }, account: { provider: 'google' } })
    await cb.jwt({ token })
    await cb.jwt({ token })

    expect(accountStore.calls).toEqual(['founder@example.com'])
  })

  it('refuses a sign-in with no email, since email is the account identity', () => {
    const cb = callbacks(store())
    expect(cb.signIn({ profile: {}, user: {} })).toBe(false)
    expect(cb.signIn({ profile: { email: 'founder@example.com' }, user: {} })).toBe(true)
  })
})
