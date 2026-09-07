'use client'

import { useEffect, useState } from 'react'
import { t as defaultTranslate, type Translate } from '../strings'
import { rememberPreviewedDomain } from './previewed-domain'
import { requestGoogleSignIn, type SignInOutcome } from './signin-exchange'

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
 * The button runs two requests rather than submitting a form. It was a form,
 * and the form did not work: the sign-in library refuses a post that does not
 * carry the anti-forgery token it hands out, so every press landed the visitor
 * on the library's own error page. Fetching the token first is what the
 * sign-out control already does. The cost is that a visitor whose scripts never
 * arrived now presses a button that does nothing rather than one that fails —
 * the same trade the sign-out control made, and not a loss, because signing in
 * without scripts did not work before either.
 *
 * Only Google is offered today. Email sign-in is specified and unbuilt: the
 * sign-in library will not run a magic-link provider without somewhere to store
 * the single-use token, and no card has created that table's usage yet.
 */

export interface SignInProps {
  readonly t?: Translate
  /** The domain the visitor previewed, carried through from the teaser link. */
  readonly previewedDomain?: string | null
  /** Where to land after signing in. */
  readonly next?: string
  /** Overridden only by tests, which point the exchange at real sign-in handlers. */
  readonly signIn?: (callbackUrl: string) => Promise<SignInOutcome>
  /** Where the browser goes to meet the identity provider. */
  readonly navigate?: (url: string) => void
}

type Phase = 'idle' | 'starting' | 'failed'

export function SignIn({
  t = defaultTranslate,
  previewedDomain,
  next = '/plan',
  signIn = (callbackUrl) =>
    requestGoogleSignIn({ fetch: globalThis.fetch.bind(globalThis), callbackUrl }),
  navigate = (url) => window.location.assign(url),
}: SignInProps) {
  const [phase, setPhase] = useState<Phase>('idle')

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

      {previewedDomain ? (
        <p className="sortiva-signin__previewed" data-testid="previewed-domain">
          {t('signin.previewedDomain', { domain: previewedDomain })}
        </p>
      ) : null}
    </section>
  )
}
