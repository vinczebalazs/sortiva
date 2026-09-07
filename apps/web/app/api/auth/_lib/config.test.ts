import { describe, expect, it } from 'vitest'
import type { AccountStore } from '@sortiva/core'
import { buildAuthAdapter, type AuthUserStore, type VerificationTokenStore } from './adapter'
import { SESSION_MAX_AGE_SECONDS, buildAuthConfig } from './config'
import { memorySessionStore } from './memorySessions'

/**
 * A session exists only once it names an account, and that is the only place a
 * request learns its `account_id`. These drive the real Auth.js callbacks;
 * storage is in memory.
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

function deps(accountStore: AccountStore = store()) {
  const tokens: VerificationTokenStore = {
    async create() {},
    async use() {
      return undefined
    },
  }
  const users: AuthUserStore = {
    async findByEmail() {
      return undefined
    },
    async findById() {
      return undefined
    },
  }
  const sessions = memorySessionStore(users)
  const revoked: string[] = []
  return {
    revoked,
    sessions,
    config: {
      adapter: buildAuthAdapter({
        tokens,
        users,
        sessions: sessions.store,
        provisioning: { store: accountStore },
      }),
      revokeAllSessions: async (accountId: string) => {
        revoked.push(accountId)
      },
    },
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function callbacks() {
  return buildAuthConfig(deps().config).callbacks as any
}

describe('Auth.js configuration (main §4.1, tech §3)', () => {
  it('keeps sessions in the database, so one can be ended before it lapses', () => {
    const config = buildAuthConfig(deps().config)
    expect(config.session?.strategy).toBe('database')
    expect(config.adapter).toBeDefined()
  })

  it('lasts a month now that lapsing is no longer the only way a session ends', () => {
    expect(SESSION_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 30)
    expect(buildAuthConfig(deps().config).session?.maxAge).toBe(SESSION_MAX_AGE_SECONDS)
  })

  it('never extends a live session, so a signed-in request costs a read and no write', () => {
    // The library extends a session only once it is older than `updateAge`. Set
    // equal to the lifetime, that moment never arrives while the session is
    // still live — which is what keeps a write off the read path.
    const config = buildAuthConfig(deps().config)
    expect(config.session?.updateAge).toBe(config.session?.maxAge)
  })

  it('requests identity scopes only — Search Console is a separate consent (invariant 21)', () => {
    const config = buildAuthConfig(deps().config)
    const google = config.providers[0] as any
    const scope: string = google.options.authorization.params.scope
    expect(scope).toBe('openid email profile')
    expect(scope).not.toMatch(/webmasters|googleapis/)
  })

  it('puts the account id on the session, and nothing else the library handed in', () => {
    const session = callbacks().session({
      session: {
        sessionToken: 'the-browsers-own-cookie',
        userId: 'acct_1',
        expires: new Date('2026-10-04T00:00:00Z'),
        user: { id: 'acct_1', email: 'founder@example.com', emailVerified: null },
      },
      user: { id: 'acct_1', email: 'founder@example.com', emailVerified: null },
    })

    expect(session.user).toEqual({ id: 'acct_1', email: 'founder@example.com' })
    // `GET /api/auth/session` returns this object to the page. The cookie it was
    // read from is unreadable to scripts; echoing it back here would undo that.
    expect(JSON.stringify(session)).not.toContain('the-browsers-own-cookie')
  })

  it('refuses a sign-in with no email, since email is the account identity', () => {
    const cb = callbacks()
    expect(cb.signIn({ profile: {}, user: {} })).toBe(false)
    expect(cb.signIn({ profile: { email: 'founder@example.com' }, user: {} })).toBe(true)
  })

  it('ends every session the account has when one browser signs out', async () => {
    const wiring = deps()
    const events = buildAuthConfig(wiring.config).events as any

    await events.signOut({ session: { sessionToken: 'x', userId: 'acct_1', expires: new Date() } })

    expect(wiring.revoked).toEqual(['acct_1'])
  })

  it('has nothing to revoke when the cookie signed out with was already stale', async () => {
    const wiring = deps()
    const events = buildAuthConfig(wiring.config).events as any

    await events.signOut({ session: null })

    expect(wiring.revoked).toEqual([])
  })
})
