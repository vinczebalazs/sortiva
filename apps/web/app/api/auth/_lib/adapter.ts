import type { Adapter, AdapterUser, VerificationToken } from 'next-auth/adapters'
import { provisionAccount, type ProvisionAccountDeps } from '@sortiva/core'

/**
 * What Auth.js needs from our storage before it will run email sign-in.
 *
 * The library refuses to start a magic-link provider without an adapter that
 * can store a single-use link token and look an account up by address. That is
 * the whole reason this file exists — not database sessions, which the library
 * asks for only when the session strategy is `database` and which this app does
 * not have a table for. Sessions stay self-contained tokens; see `config.ts`.
 *
 * Three of the methods here are honest no-ops, and each is a no-op for a reason
 * stated at the method. The rule they follow: **the account's identity is its
 * email address**, which is what the unique index on `accounts.email` already
 * says and what sign-in has always done in practice.
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

export interface AuthAdapterDeps {
  readonly tokens: VerificationTokenStore
  readonly users: AuthUserStore
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
  }
}
