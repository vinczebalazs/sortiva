'use client'

import { useEffect, useState } from 'react'
import { t as defaultTranslate, type Translate } from '../strings'
import { rememberPreviewedDomain } from './previewed-domain'
import {
  requestEmailSignIn,
  requestGoogleSignIn,
  type EmailSignInOutcome,
  type SignInOutcome,
} from './signin-exchange'

/**
 * Sign-in and sign-up are the same screen: an account is created the first time
 * somebody signs in, so there is no separate registration form to fill in.
 *
 * A visitor who arrived from the landing preview brings the address they typed
 * with them. It is carried forward as a **suggestion** for the connect step and
 * nothing more — a domain is never claimed on somebody's behalf, because a
 * claim is exclusive and one made by mistake locks a business out of its own
 * address. It is put into the tab's own storage on arrival, because the rest of
 * the journey leaves our site twice — the identity provider, then Stripe — and
 * a link parameter survives neither hop.
 *
 * Both buttons run two requests rather than submitting a form. It was a form,
 * and the form did not work: the sign-in library refuses a post that does not
 * carry the anti-forgery token it hands out, so every press landed the visitor
 * on the library's own error page. Fetching the token first is what the
 * sign-out control already does. The cost is that a visitor whose scripts never
 * arrived now presses a button that does nothing rather than one that fails —
 * the same trade the sign-out control made, and not a loss, because signing in
 * without scripts did not work before either.
 *
 * **Two ways in, because one of them is somebody else's account.** A merchant
 * with no Google account, or unwilling to use a personal one to reach a
 * business tool, could not get in at all while this screen offered one button.
 * The link is the way in that depends on nothing but a mailbox.
 *
 * Pressing the link button does not sign anybody in and does not say whether
 * the address has an account — it is sent one either way, and the account is
 * created when the link is opened. Nothing on this screen ever reveals who is
 * registered.
 */

export interface SignInProps {
  readonly t?: Translate
  /** The domain the visitor previewed, carried through from the teaser link. */
  readonly previewedDomain?: string | null
  /** Where to land after signing in. */
  readonly next?: string
  /** Overridden only by tests, which point the exchange at real sign-in handlers. */
  readonly signIn?: (callbackUrl: string) => Promise<SignInOutcome>
  /** Overridden only by tests, as `signIn` is. */
  readonly sendSignInLink?: (email: string, callbackUrl: string) => Promise<EmailSignInOutcome>
  /** Where the browser goes to meet the identity provider. */
  readonly navigate?: (url: string) => void
}

type Phase = 'idle' | 'starting' | 'failed'

/** The two link states the Google button has no equivalent of. */
type LinkPhase = 'idle' | 'sending' | 'sent' | 'failed'

/**
 * Enough to catch a typed mistake before it costs a round trip and comes back
 * as a generic failure. Deliberately not a full address grammar: the server
 * rejects what it will not send to, and a stricter pattern here would turn
 * "we can't deliver that" into "this button does nothing", which is worse.
 */
function looksLikeAnAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(value.trim())
}

export function SignIn({
  t = defaultTranslate,
  previewedDomain,
  next = '/plan',
  signIn = (callbackUrl) =>
    requestGoogleSignIn({ fetch: globalThis.fetch.bind(globalThis), callbackUrl }),
  sendSignInLink = (email, callbackUrl) =>
    requestEmailSignIn({ fetch: globalThis.fetch.bind(globalThis), email, callbackUrl }),
  navigate = (url) => window.location.assign(url),
}: SignInProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [linkPhase, setLinkPhase] = useState<LinkPhase>('idle')
  const [email, setEmail] = useState('')

  useEffect(() => {
    rememberPreviewedDomain(previewedDomain)
  }, [previewedDomain])

  async function pressGoogle() {
    setPhase('starting')
    const outcome = await signIn(next)
    if (outcome.kind === 'handshake_started') {
      // Left showing "taking you to Google" on purpose — the browser is leaving.
      navigate(outcome.url)
      return
    }
    setPhase('failed')
  }

  const canAskForLink = linkPhase !== 'sending' && looksLikeAnAddress(email)

  async function pressLink() {
    if (!canAskForLink) return
    setLinkPhase('sending')
    const outcome = await sendSignInLink(email.trim(), next)
    setLinkPhase(outcome.kind === 'link_sent' ? 'sent' : 'failed')
  }

  return (
    <section className="sortiva-signin" data-testid="signin">
      <h1 className="sortiva-signin__heading">{t('signin.heading')}</h1>
      <p className="sortiva-signin__body">{t('signin.body')}</p>

      <button
        className="sortiva-signin__provider"
        type="button"
        data-testid="signin-google"
        disabled={phase === 'starting'}
        onClick={() => void pressGoogle()}
      >
        {t(phase === 'starting' ? 'signin.googleStarting' : 'signin.google')}
      </button>

      {phase === 'failed' ? (
        <p className="sortiva-signin__failed" role="alert" data-testid="signin-failed">
          {t('signin.failed')}
        </p>
      ) : null}

      <p className="sortiva-signin__or">{t('signin.or')}</p>

      {linkPhase === 'sent' ? (
        <p className="sortiva-signin__sent" role="status" data-testid="signin-link-sent">
          {t('signin.emailSent', { email: email.trim() })}
        </p>
      ) : (
        <div className="sortiva-signin__email">
          <label className="sortiva-signin__label" htmlFor="signin-email">
            {t('signin.emailLabel')}
          </label>
          <input
            className="sortiva-signin__input"
            id="signin-email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            placeholder={t('signin.emailPlaceholder')}
            data-testid="signin-email"
            onChange={(event) => setEmail(event.target.value)}
            // There is no form to submit, so Enter has to be wired by hand or
            // it does nothing — which in a one-field box reads as a dead screen.
            onKeyDown={(event) => {
              if (event.key === 'Enter') void pressLink()
            }}
          />
          <button
            className="sortiva-signin__provider"
            type="button"
            data-testid="signin-email-submit"
            disabled={!canAskForLink}
            onClick={() => void pressLink()}
          >
            {t(linkPhase === 'sending' ? 'signin.emailSending' : 'signin.email')}
          </button>
        </div>
      )}

      {linkPhase === 'failed' ? (
        <p className="sortiva-signin__failed" role="alert" data-testid="signin-link-failed">
          {t('signin.failed')}
        </p>
      ) : null}

      {previewedDomain ? (
        <p className="sortiva-signin__previewed" data-testid="previewed-domain">
          {t('signin.previewedDomain', { domain: previewedDomain })}
        </p>
      ) : null}
    </section>
  )
}
