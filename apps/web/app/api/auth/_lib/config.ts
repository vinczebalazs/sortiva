import type { NextAuthConfig } from 'next-auth'
import type { Adapter } from 'next-auth/adapters'
import Google from 'next-auth/providers/google'
import type { SendSignInLink } from './signInEmail'

/**
 * Email and Google sign-in, nothing exotic. Session-cookie auth, and every
 * authenticated route resolves `account_id` from the session rather than from
 * the request body — which is the difference between a scoped read and one
 * account naming another.
 *
 * **The account's identity is its email address.** One address is one account,
 * whichever way somebody signs in, which is what the unique index on
 * `accounts.email` says and what sign-in has always done.
 *
 * **A session is now a row, and ending it is deleting that row.** It used to be
 * a self-contained signed cookie: nothing recorded that it existed, so nothing
 * could stop it — a copy of the cookie stayed good for its whole lifetime, and
 * "sign out" only cleared it in the browser that pressed it. The price of the
 * change is one database read on every signed-in request.
 */

/**
 * How long a session lasts when nobody ends it.
 *
 * This was a single day, and it was a day *because* a session could not be
 * ended: lapsing was the only thing that ever stopped a leaked cookie, so it had
 * to come round quickly. Revoking is now the answer to a leaked cookie — it is
 * immediate and it reaches every browser — so the lifetime no longer carries
 * that job and goes back to being about how often a merchant is made to sign in
 * again. A month is the sign-in library's own default for stored sessions.
 */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

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

export interface EmailSignInDeps {
  readonly sendLink: SendSignInLink
}

export interface AuthConfigDeps {
  /**
   * Storage. No longer optional: sessions live in the database now, and a
   * sign-in configuration with nowhere to keep them is one that cannot work.
   */
  readonly adapter: Adapter
  /**
   * Ends every session the account has. Wired to the same `sessions` table the
   * adapter writes; a separate dependency because signing out is an event rather
   * than an adapter method, and because the adapter's own delete must stay
   * narrow (see its note there).
   */
  readonly revokeAllSessions: (accountId: string) => Promise<void>
  /**
   * Omitted only by tests that drive the callbacks directly. The single
   * production instantiation always supplies it, and `authWiring.test.ts`
   * asserts that, so email sign-in cannot quietly fall off the sign-in screen.
   */
  readonly email?: EmailSignInDeps
}

export function buildAuthConfig(deps: AuthConfigDeps): NextAuthConfig {
  return {
    // Deployed behind a proxy the auth library does not recognise on its own.
    trustHost: true,
    session: {
      strategy: 'database',
      maxAge: SESSION_MAX_AGE_SECONDS,
      // A session's lapse date is fixed when it is created and never moved, and
      // this is what fixes it: the library extends a session only once it is
      // older than `updateAge`, so setting that equal to the lifetime means the
      // moment never arrives. The alternative — a sliding window — would put a
      // database *write* on the read path every so often, and the read path is
      // exactly where this feature's whole cost was budgeted at one read.
      updateAge: SESSION_MAX_AGE_SECONDS,
    },
    adapter: deps.adapter,
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
       * The only place a request learns its `account_id`.
       *
       * Built fresh rather than by spreading what the library hands in. What it
       * hands in is the stored session row with the account attached, and that
       * row is the body of `GET /api/auth/session` — so spreading it would
       * publish the session's own token to any script on the page, undoing the
       * fact that the cookie carrying it is unreadable to scripts.
       *
       * There is no signup here any more. It happens in the adapter's
       * `createUser`, which the library calls first for both ways in, so
       * `signup_completed` fires once and in one place.
       */
      session({ session, user }) {
        return {
          user: { id: user.id, email: user.email },
          expires: new Date(session.expires).toISOString(),
        }
      },
    },
    events: {
      /**
       * **Signing out signs you out everywhere.**
       *
       * The library has already deleted the one session that pressed the button;
       * this ends the rest. That is the deliberate choice: a merchant who signs
       * out because a laptop went missing, or because they think somebody has
       * their cookie, means *stop*, and a sign-out that leaves the copied cookie
       * working answers a different question from the one they asked. The cost
       * is that signing out on a phone also signs the desktop out — visible,
       * undoable in one click, and the safe direction to be wrong in.
       *
       * There is no session to name when the cookie was already stale, in which
       * case there is nothing left to revoke either.
       */
      async signOut(message) {
        const session = 'session' in message ? message.session : undefined
        const accountId =
          session && typeof session === 'object' && 'userId' in session
            ? session.userId
            : undefined
        if (typeof accountId === 'string' && accountId.length > 0) {
          await deps.revokeAllSessions(accountId)
        }
      },
    },
  }
}
