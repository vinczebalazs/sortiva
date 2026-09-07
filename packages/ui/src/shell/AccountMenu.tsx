'use client'

import { useMemo, useState } from 'react'
import { createTranslate, DEFAULT_LANGUAGE, type UiLanguage } from '../strings'
import { AccountIcon } from './icons'
import { requestSignOut, type SignOutOutcome } from './signout'

/**
 * The account control in the shell's toolbar, and the one place in the product
 * a merchant can sign out.
 *
 * It opens onto a panel rather than being a bare button because signing out
 * here does something a sign-out button is not usually expected to do: it ends
 * the account's session in **every** browser it is signed in on, not only this
 * one. That is the product's deliberate answer to "my laptop is gone" — and a
 * merchant who has not been told would find out by discovering their desktop
 * signed out. So the sentence is on screen before the button is pressed, not
 * afterwards in a toast.
 *
 * A `details` disclosure rather than a panel opened by React state, for the
 * reason the navigation rail's "More" control gives: it opens and closes with
 * no JavaScript at all. The sign-out itself does need scripts — it is two
 * requests, and the second one spends a token the first one fetches — so a
 * merchant whose scripts never arrived sees the explanation and a button that
 * does nothing. That is the same failure the rest of the product has, and it
 * is better than a control that is invisible until a bundle loads.
 *
 * `language` rather than a `t` function, for the reason the bell states beside
 * it: a translate function is a closure React refuses to serialise from the
 * server layout into a client component.
 */

export interface AccountMenuProps {
  readonly language?: UiLanguage
  /** Overridden only by tests, which point the exchange at real sign-in handlers. */
  readonly signOut?: () => Promise<SignOutOutcome>
  /** Where the browser goes once the session is gone. */
  readonly navigate?: (url: string) => void
}

type Phase = 'idle' | 'signing_out' | 'failed'

export function AccountMenu({
  language = DEFAULT_LANGUAGE,
  signOut = () => requestSignOut({ fetch: globalThis.fetch.bind(globalThis) }),
  navigate = (url) => window.location.assign(url),
}: AccountMenuProps) {
  const t = useMemo(() => createTranslate(language), [language])
  const [phase, setPhase] = useState<Phase>('idle')

  async function pressSignOut() {
    setPhase('signing_out')
    const outcome = await signOut()
    if (outcome.kind === 'signed_out') {
      // Left showing "signing out" on purpose — the browser is leaving.
      navigate(outcome.url)
      return
    }
    setPhase('failed')
  }

  return (
    <details className="sortiva-account" data-testid="account-menu">
      <summary className="sortiva-account__button" aria-label={t('shell.account')}>
        <AccountIcon />
      </summary>

      <div className="sortiva-account__panel">
        <h2 className="sortiva-account__heading">{t('shell.account')}</h2>

        <p className="sortiva-account__note" data-testid="sign-out-reach">
          {t('shell.accountMenu.signOutEverywhere')}
        </p>

        <button
          type="button"
          className="sortiva-account__signout"
          data-testid="sign-out"
          disabled={phase === 'signing_out'}
          onClick={() => void pressSignOut()}
        >
          {t(
            phase === 'signing_out'
              ? 'shell.accountMenu.signingOut'
              : 'shell.accountMenu.signOut',
          )}
        </button>

        {phase === 'failed' ? (
          <p className="sortiva-account__failed" role="alert" data-testid="sign-out-failed">
            {t('shell.accountMenu.signOutFailed')}
          </p>
        ) : null}
      </div>
    </details>
  )
}
