import type { NextAuthConfig } from 'next-auth'
import type { Adapter } from 'next-auth/adapters'
import Google from 'next-auth/providers/google'
import { provisionAccount, type ProvisionAccountDeps } from '@sortiva/core'
import type { SendSignInLink } from './signInEmail'

/**
 * Email and Google sign-in, nothing exotic. Session-cookie auth, and every
 * authenticated route resolves `account_id` from the session rather than from
 * the request body — which is the difference between a scoped read and one
 * account naming another.
 *
 * **The account's identity is its email address.** One address is one account,
 * whichever way somebody signs in, which is what the unique index on
 * `accounts.email` says and what sign-in has always done. Both consequences
 * below follow from that single fact.
 *
 * **Sessions are still self-contained tokens, and still cannot be revoked
 * before they expire.** `T1.1` recorded that as forced by the absence of an
 * adapter; that is no longer the reason. The reason now is that database-backed
 * sessions need a `sessions` table and no schema wave has created one — see
 * DECISIONS 2026-09-02 T-EMAIL. `maxAge` stays at a day because expiry remains
 * the only way a session ends.
 */

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24

/**
 * How long a sign-in link stays usable. Short, because the link is a bearer
 * credential sitting in a mailbox: anyone holding the message holds the
 * account until it lapses. Fifteen minutes is comfortably longer than mail
 * delivery and short enough that a forwarded or archived message is inert.
 * Auth.js's own default is a full day.
 */
export const SIGN_IN_LINK_MAX_AGE_SECONDS = 15 * 60

/** The provider id in the sign-in URL: `POST /api/auth/signin/email`. */
export const EMAIL_PROVIDER_ID = 'email'

/** What we put on the token and read back off the session. */
export const ACCOUNT_ID_CLAIM = 'accountId'

export interface EmailSignInDeps {
  /** Storage for outstanding links, plus the account lookups Auth.js needs. */
  readonly adapter: Adapter
  readonly sendLink: SendSignInLink
}

export interface AuthConfigDeps {
  /** Binds the account row's creation to storage; `apps/web` supplies the DB-backed one. */
  readonly provisioning: ProvisionAccountDeps
  /**
   * Omitted only by tests that drive the callbacks directly. The single
   * production instantiation always supplies it, and `authDeps.test.ts` asserts
   * that, so email sign-in cannot quietly fall off the sign-in screen.
   */
  readonly email?: EmailSignInDeps
}

export function buildAuthConfig(deps: AuthConfigDeps): NextAuthConfig {
  return {
    // Deployed behind a proxy the auth library does not recognise on its own.
    trustHost: true,
    session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_SECONDS },
    ...(deps.email ? { adapter: deps.email.adapter } : {}),
    providers: [
      Google({
        clientId: process.env.AUTH_GOOGLE_ID,
        clientSecret: process.env.AUTH_GOOGLE_SECRET,
        // Identity only. Search Console is a separate OAuth client
        // with its own consent screen (invariant 21, read and write are
        // separate consents; see .env.example GSC_OAUTH_CLIENT_ID).
        authorization: { params: { scope: 'openid email profile' } },
        // Signing in with Google and signing in with a link to the same address
        // reach the same account, because the address is the identity. Without
        // this the library would refuse the second one as an unlinked duplicate
        // — it has no record tying a Google id to an account and never will.
        // What makes it safe rather than dangerous is the `signIn` guard below,
        // which turns away any provider that will not vouch for the address.
        allowDangerousEmailAccountLinking: true,
      }),
      ...(deps.email
        ? [
            {
              id: EMAIL_PROVIDER_ID,
              type: 'email' as const,
              name: 'Email',
              maxAge: SIGN_IN_LINK_MAX_AGE_SECONDS,
              // Not Auth.js's bundled provider: that one talks SMTP through
              // Nodemailer, and every email this product sends goes through the
              // one instrumented `EmailProvider` wrapper (invariant 25).
              sendVerificationRequest: async ({
                identifier,
                url,
                token,
              }: {
                identifier: string
                url: string
                token: string
              }) => {
                await deps.email!.sendLink({
                  to: identifier,
                  url,
                  token,
                  validForMinutes: Math.round(SIGN_IN_LINK_MAX_AGE_SECONDS / 60),
                })
              },
            },
          ]
        : []),
    ],
    callbacks: {
      /**
       * Refuse a sign-in we cannot attach to an account, and refuse one whose
       * address we have no reason to believe.
       *
       * The second half matters because the account is the address: an identity
       * provider that handed us an address it had not itself verified could
       * hand us somebody else's. Google states whether it verified; we take
       * "no" for an answer. A missing statement is not treated as a "no", so a
       * provider that simply omits the claim does not lock everybody out.
       */
      signIn({ profile, user, account }) {
        if (!(profile?.email ?? user?.email)) return false
        const isOauth = account?.type === 'oauth' || account?.type === 'oidc'
        if (isOauth && profile && profile.email_verified === false) return false
        return true
      },

      /**
       * Runs on sign-in and on every session refresh. The account row is
       * resolved once — on the sign-in pass, where `user` is present — and the
       * id then rides the token, so a refresh costs no query.
       *
       * Signup itself happens in the adapter's `createUser`, which the library
       * calls first. This call therefore finds the row rather than creating it,
       * and `signup_completed` fires once, there.
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

      /** The only place a request learns its `account_id`. */
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
