import type { Adapter, AdapterSession, AdapterUser, VerificationToken } from 'next-auth/adapters'
import { provisionAccount, type ProvisionAccountDeps } from '@sortiva/core'
import { sessionTokenDigest } from './sessionToken'

/**
 * What Auth.js needs from our storage before it will run email sign-in and keep
 * sessions where they can be ended.
 *
 * The library refuses to start a magic-link provider without an adapter that can
 * store a single-use link token and look an account up by address, and it
 * refuses to keep sessions anywhere but a signed cookie unless the adapter
 * carries all five session methods at the bottom of this file.
 *
 * Three of the methods here are honest no-ops, and each is a no-op for a reason
 * stated at the method. The rule they follow: **the account's identity is its
 * email address**, which is what the unique index on `accounts.email` already
 * says and what sign-in has always done in practice.
 *
 * **What is stored for a session is a digest, never the cookie itself** — see
 * `sessionToken.ts` for why. Every session method below hashes on the way in and
 * hands the library back the raw value it was given, because that raw value is
 * what identifies the session to the browser holding it.
 */

/** Storage for outstanding sign-in links. Bound to `verification_tokens` in `provisioning.ts`. */
export interface VerificationTokenStore {
  create(input: { identifier: string; token: string; expires: Date }): Promise<void>
  /** Reads and deletes in one statement, so a link opens exactly one session. */
  use(input: {
    identifier: string
    token: string
  }): Promise<{ identifier: string; token: string; expires: Date } | undefined>
}

/** The account reads sign-in needs. Writes go through `provisionAccount`, never here. */
export interface AuthUserStore {
  findByEmail(email: string): Promise<{ id: string; email: string } | undefined>
  findById(id: string): Promise<{ id: string; email: string } | undefined>
}

/**
 * Storage for signed-in browsers. Bound to the `sessions` table in
 * `provisioning.ts`.
 *
 * Every method takes a digest rather than the browser's own value, and the
 * parameter is named so, because nothing below this line should ever hold a
 * working credential.
 */
export interface AuthSessionStore {
  create(input: { accountId: string; tokenDigest: string; expires: Date }): Promise<void>
  /** The one read that runs on every signed-in request. */
  findWithAccount(
    tokenDigest: string,
  ): Promise<{ accountId: string; email: string; expires: Date } | undefined>
  touch(input: { tokenDigest: string; expires: Date }): Promise<void>
  /** Returns whose session it was, so signing out can go on to end the rest of them. */
  remove(tokenDigest: string): Promise<{ accountId: string; expires: Date } | undefined>
  /** Every session one account has. "Sign out everywhere", and account deletion. */
  removeAllForAccount(accountId: string): Promise<number>
}

export interface AuthAdapterDeps {
  readonly tokens: VerificationTokenStore
  readonly users: AuthUserStore
  readonly sessions: AuthSessionStore
  /** The same signup path Google sign-in uses, so `signup_completed` fires once and in one place. */
  readonly provisioning: ProvisionAccountDeps
}

/**
 * `emailVerified` is part of the shape Auth.js hands around and nothing in this
 * product reads it, so it is answered in memory and never stored. There is no
 * column for it, and inventing one would be a schema change for a field with no
 * consumer.
 */
function asAdapterUser(account: { id: string; email: string }): AdapterUser {
  return { id: account.id, email: account.email, emailVerified: null }
}

export function buildAuthAdapter(deps: AuthAdapterDeps): Adapter {
  return {
    async createVerificationToken(token: VerificationToken) {
      await deps.tokens.create({
        identifier: token.identifier,
        token: token.token,
        expires: token.expires,
      })
      return token
    },

    async useVerificationToken(input: { identifier: string; token: string }) {
      return (await deps.tokens.use(input)) ?? null
    },

    async getUserByEmail(email: string) {
      const account = await deps.users.findByEmail(email.trim().toLowerCase())
      return account ? asAdapterUser(account) : null
    },

    async getUser(id: string) {
      const account = await deps.users.findById(id)
      return account ? asAdapterUser(account) : null
    },

    /**
     * The signup moment, for both ways in. It runs the same
     * insert-with-conflict Google sign-in has always run, so two callbacks for
     * one address cannot produce two accounts and the funnel event fires only
     * on the row that was actually created.
     *
     * Which way in gets recorded on that event is read off `emailVerified`, and
     * that is not a trick: the field is set exactly when *we* have just proved
     * the address ourselves, by sending a link to it and watching somebody open
     * it. An identity provider asserting an address leaves it unset. So "we
     * verified it" and "this is an email signup" are the same fact.
     */
    async createUser(user: Omit<AdapterUser, 'id'>) {
      const email = user.email.trim().toLowerCase()
      const { accountId } = await provisionAccount(deps.provisioning, {
        email,
        provider: user.emailVerified ? 'email' : 'oauth',
      })
      return { id: accountId, email, emailVerified: null }
    },

    /**
     * Auth.js calls this after a magic link is followed, to stamp the address as
     * verified. We hold no such column and nothing would read it, so the update
     * is dropped and the account handed straight back. Following the link is
     * still what proves the address — it just leaves no trace of its own.
     */
    async updateUser(user: Partial<AdapterUser> & { id: string }) {
      const account = await deps.users.findById(user.id)
      if (!account) throw new Error(`no account ${user.id}`)
      return asAdapterUser(account)
    },

    /**
     * We store no link between a Google identity and an account, so this can
     * only ever answer "unknown" — and answering that sends Auth.js on to match
     * by email instead, which is the behaviour sign-in has always had. Storing
     * the link would need a table of provider ids that no schema wave has
     * created and nothing else would read.
     */
    async getUserByAccount() {
      return null
    },

    /** Nothing to record: see `getUserByAccount`. */
    async linkAccount() {
      return undefined
    },

    /** A browser has just signed in. This row is what makes that session endable. */
    async createSession(session: AdapterSession) {
      await deps.sessions.create({
        accountId: session.userId,
        tokenDigest: sessionTokenDigest(session.sessionToken),
        expires: session.expires,
      })
      return session
    },

    /**
     * The whole cost of revocable sessions: one read, on every signed-in
     * request. A miss is a session that has been ended — Auth.js treats that
     * exactly as it treats an unknown cookie, and clears it.
     *
     * The session handed back names the browser's own token, not the digest we
     * looked it up by; the digest is an implementation detail of storage and has
     * no business travelling any further.
     */
    async getSessionAndUser(sessionToken: string) {
      const found = await deps.sessions.findWithAccount(sessionTokenDigest(sessionToken))
      if (!found) return null
      return {
        session: { sessionToken, userId: found.accountId, expires: found.expires },
        user: asAdapterUser({ id: found.accountId, email: found.email }),
      }
    },

    /**
     * Pushes a session's lapse date out. Present because Auth.js refuses to run
     * database sessions without it, and unreachable as configured: sessions have
     * a fixed lifetime from sign-in, so the library never finds one due to be
     * extended. See the note on `updateAge` in `config.ts`.
     */
    async updateSession(session: Partial<AdapterSession> & Pick<AdapterSession, 'sessionToken'>) {
      if (!session.expires) return null
      await deps.sessions.touch({
        tokenDigest: sessionTokenDigest(session.sessionToken),
        expires: session.expires,
      })
      return null
    },

    /**
     * Ends exactly this session and no other.
     *
     * Deliberately narrow, even though signing out ends every session the
     * account has: the library also calls this when a lapsed cookie is cleaned
     * up, and when somebody follows a sign-in link for a *different* account in
     * a browser that is already signed in. Widening it here would sign a
     * stranger out of their other devices. The fan-out belongs to the sign-out
     * event alone — see `config.ts`.
     */
    async deleteSession(sessionToken: string) {
      const ended = await deps.sessions.remove(sessionTokenDigest(sessionToken))
      if (!ended) return null
      return { sessionToken, userId: ended.accountId, expires: ended.expires }
    },
  }
}
