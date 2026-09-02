'use client'

import { useEffect } from 'react'
import { t as defaultTranslate, type Translate } from '../strings'
import { rememberPreviewedDomain } from './previewed-domain'

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
  /** The form target that starts the provider handshake. */
  readonly action?: string
}

export function SignIn({
  t = defaultTranslate,
  previewedDomain,
  next = '/plan',
  action = '/api/auth/signin/google',
}: SignInProps) {
  useEffect(() => {
    rememberPreviewedDomain(previewedDomain)
  }, [previewedDomain])

  return (
    <section className="sortiva-signin" data-testid="signin">
      <h1 className="sortiva-signin__heading">{t('signin.heading')}</h1>
      <p className="sortiva-signin__body">{t('signin.body')}</p>

      <form className="sortiva-signin__form" method="post" action={action}>
        <input type="hidden" name="callbackUrl" value={next} />
        <button className="sortiva-signin__provider" type="submit" data-testid="signin-google">
          {t('signin.google')}
        </button>
      </form>

      {previewedDomain ? (
        <p className="sortiva-signin__previewed" data-testid="previewed-domain">
          {t('signin.previewedDomain', { domain: previewedDomain })}
        </p>
      ) : null}
    </section>
  )
}
