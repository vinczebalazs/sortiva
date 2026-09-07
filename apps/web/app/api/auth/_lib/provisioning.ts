import {
  SESSION_LOOKUP_REASON,
  accountScope,
  createOrFindAccountByEmail,
  createSession,
  createVerificationToken,
  db,
  deleteSession,
  deleteSessionsForAccount,
  findAccountByEmail,
  findAccountById,
  findSessionWithAccount,
  systemScope,
  touchSession,
  useVerificationToken,
  type Db,
} from '@sortiva/db'
import type { AccountStore, EmailProvider, ProvisionAccountDeps } from '@sortiva/core'
import { PosthogServerCapture, ResendEmailProvider } from '@sortiva/providers'
import {
  buildAuthAdapter,
  type AuthSessionStore,
  type AuthUserStore,
  type VerificationTokenStore,
} from './adapter'
import { sendSignInLinkVia } from './signInEmail'
import type { AuthConfigDeps } from './config'

/**
 * The composition root for sign-in: the one place `packages/core`'s ports meet
 * the database, PostHog and the email vendor. Core owns no persistence
 * (CLAUDE.md code-structure rules), so this binding lives in `apps/web`.
 */

const SIGNUP_SCOPE_REASON = 'signup: the account being created is the one being resolved'
const SIGN_IN_LINK_SCOPE_REASON =
  'email sign-in: a link is issued to an address that may have no account yet'

export function makeDbAccountStore(injectedDatabase?: Db): AccountStore {
  return {
    async createOrFindByEmail(email: string) {
      const { account, created } = await createOrFindAccountByEmail(
        injectedDatabase ?? db(),
        systemScope(SIGNUP_SCOPE_REASON),
        email,
      )
      return { accountId: account.id, created }
    },
  }
}

export const dbAccountStore = makeDbAccountStore()

/** Reads only. The one write sign-in performs still goes through `provisionAccount`. */
export function makeDbAuthUserStore(injectedDatabase?: Db): AuthUserStore {
  return {
    async findByEmail(email: string) {
      const row = await findAccountByEmail(
        injectedDatabase ?? db(),
        systemScope(SIGN_IN_LINK_SCOPE_REASON),
        email,
      )
      return row ? { id: row.id, email: row.email } : undefined
    },
    async findById(id: string) {
      const row = await findAccountById(injectedDatabase ?? db(), accountScope(id))
      return row ? { id: row.id, email: row.email } : undefined
    },
  }
}

export function makeDbVerificationTokenStore(injectedDatabase?: Db): VerificationTokenStore {
  const scope = () => systemScope(SIGN_IN_LINK_SCOPE_REASON)
  return {
    async create(input) {
      await createVerificationToken(injectedDatabase ?? db(), scope(), input)
    },
    async use(input) {
      return await useVerificationToken(injectedDatabase ?? db(), scope(), input)
    },
  }
}

/**
 * Signed-in browsers. The lookup is the read that happens on every signed-in
 * request; the two deletes are how a session ends before it lapses.
 */
export function makeDbAuthSessionStore(injectedDatabase?: Db): AuthSessionStore {
  const database = (): Db => injectedDatabase ?? db()
  const lookupScope = () => systemScope(SESSION_LOOKUP_REASON)
  return {
    async create({ accountId, tokenDigest, expires }) {
      await createSession(database(), accountScope(accountId), { tokenDigest, expires })
    },
    async findWithAccount(tokenDigest) {
      const row = await findSessionWithAccount(database(), lookupScope(), tokenDigest)
      return row ? { accountId: row.accountId, email: row.email, expires: row.expires } : undefined
    },
    async touch(input) {
      await touchSession(database(), lookupScope(), input)
    },
    async remove(tokenDigest) {
      const row = await deleteSession(database(), lookupScope(), tokenDigest)
      return row ? { accountId: row.accountId, expires: row.expires } : undefined
    },
    async removeAllForAccount(accountId) {
      return await deleteSessionsForAccount(database(), accountScope(accountId))
    },
  }
}

let capture: PosthogServerCapture | undefined

/** `signup_completed` is a funnel event, captured server-side. */
export function provisioningDeps(): ProvisionAccountDeps {
  capture ??= new PosthogServerCapture()
  return { store: dbAccountStore, capture }
}

let emailProvider: EmailProvider | undefined

/**
 * Built on the first send rather than at import. The Resend wrapper refuses to
 * exist without an API key and a verified sender address, which is right for a
 * process about to send mail and wrong for a test that only wants to know the
 * sign-in configuration offers email at all.
 */
function resendProvider(): EmailProvider {
  emailProvider ??= new ResendEmailProvider()
  return emailProvider
}

/**
 * Everything `buildAuthConfig` needs, wired to the real world. There is exactly
 * one production call site (`auth.ts`), and a test asserts that what this
 * returns actually carries email sign-in — a wiring that is optional in the
 * type is otherwise a wiring that can be quietly dropped.
 */
export function authDeps(): AuthConfigDeps {
  const provisioning = provisioningDeps()
  const sessions = makeDbAuthSessionStore()
  return {
    adapter: buildAuthAdapter({
      tokens: makeDbVerificationTokenStore(),
      users: makeDbAuthUserStore(),
      sessions,
      provisioning,
    }),
    revokeAllSessions: async (accountId) => {
      await sessions.removeAllForAccount(accountId)
    },
    email: { sendLink: sendSignInLinkVia(resendProvider) },
  }
}
