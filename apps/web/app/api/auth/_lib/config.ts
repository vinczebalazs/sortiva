import type { NextAuthConfig } from 'next-auth'
import Google from 'next-auth/providers/google'
import { provisionAccount, type ProvisionAccountDeps } from '@sortiva/core'

/**
 * main §4.1 — "standard email + OAuth (Google) signup. Nothing exotic."
 * tech §3 — session-cookie auth, and every authenticated route resolves
 * `account_id` from the session, never from the request body.
 *
 * Two things this file does not do, both recorded in DECISIONS 2026-08-31 T1.1:
 *
 * - **No email (magic link) provider.** Auth.js refuses to start one without an
 *   adapter that can store a single-use verification token, and no schema wave
 *   has created a table for that.
 * - **No database adapter, so sessions are JWTs.** The consequence to know: a
 *   session cannot be revoked before it expires, which is why `maxAge` is a day
 *   rather than Auth.js's 30.
 */

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24

/** What we put on the token and read back off the session. */
export const ACCOUNT_ID_CLAIM = 'accountId'

export interface AuthConfigDeps {
  /** Binds the account row's creation to storage; `apps/web` supplies the DB-backed one. */
  readonly provisioning: ProvisionAccountDeps
}

export function buildAuthConfig(deps: AuthConfigDeps): NextAuthConfig {
  return {
    // tech §2.1 — deployed behind Railway's proxy, not a platform Auth.js detects.
    trustHost: true,
    session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_SECONDS },
    providers: [
      Google({
        clientId: process.env.AUTH_GOOGLE_ID,
        clientSecret: process.env.AUTH_GOOGLE_SECRET,
        // main §4.1 — identity only. Search Console is a separate OAuth client
        // with its own consent screen (invariant 21, read and write are
        // separate consents; see .env.example GSC_OAUTH_CLIENT_ID).
        authorization: { params: { scope: 'openid email profile' } },
      }),
    ],
    callbacks: {
      /**
       * Refuse a sign-in we cannot attach to an account. Auth.js will not issue
       * a session for a provider profile with no verified email, so no request
       * can arrive later carrying a session without an account id.
       */
      signIn({ profile, user }) {
        return Boolean(profile?.email ?? user?.email)
      },

      /**
       * Runs on sign-in and on every session refresh. The account row is
       * provisioned once — on the sign-in pass, where `user` is present — and
       * the id then rides the token, so a refresh costs no query.
       */
      async jwt({ token, user, account }) {
        if (token[ACCOUNT_ID_CLAIM]) return token

        const email = user?.email ?? token.email
        if (!email) return token

        const provisioned = await provisionAccount(deps.provisioning, {
          email,
          provider: account?.provider ?? 'unknown',
        })
        token[ACCOUNT_ID_CLAIM] = provisioned.accountId
        return token
      },

      /** tech §3 — this is the only place a request learns its `account_id`. */
      session({ session, token }) {
        const accountId = token[ACCOUNT_ID_CLAIM]
        if (typeof accountId === 'string') {
          session.user = { ...session.user, id: accountId }
        }
        return session
      },
    },
  }
}
