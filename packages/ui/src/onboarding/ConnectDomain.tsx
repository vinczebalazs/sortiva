'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { t as defaultTranslate, type Translate } from '../strings'
import { forgetPreviewedDomain, readPreviewedDomain } from '../public/previewed-domain'

/**
 * The first thing a merchant sees after paying: one field, for the address of
 * the store we are about to read.
 *
 * A claim is exclusive — one account per domain, forever — so nothing here
 * happens without the merchant pressing the button. The address they typed on
 * the landing page is offered back as a suggestion and never submitted for
 * them, which is why the field is pre-filled and the form is not.
 *
 * The one failure worth its own sentence is a domain somebody else already
 * claimed, because it is the only one where trying again will not help.
 */

export interface ConnectDomainProps {
  readonly t?: Translate
  readonly endpoint?: string
  readonly supportHref?: string
  /** Called after a successful claim, so the page can re-read the account. */
  readonly onClaimed?: (domain: string) => void
}

type ClaimError = 'already_claimed' | 'invalid' | 'failed' | 'empty'

const MESSAGES = {
  already_claimed: 'onboarding.connect.alreadyClaimed',
  invalid: 'onboarding.connect.invalid',
  failed: 'onboarding.connect.failed',
  empty: 'onboarding.connect.empty',
} as const

export function ConnectDomain({
  t = defaultTranslate,
  endpoint = '/api/domain/claim',
  supportHref = '/contact',
  onClaimed,
}: ConnectDomainProps) {
  const [typed, setTyped] = useState('')
  const [prefilled, setPrefilled] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<ClaimError | null>(null)

  useEffect(() => {
    // Read after mount rather than during render: the value lives in the tab,
    // which does not exist while the page is being rendered on the server.
    const remembered = readPreviewedDomain()
    if (remembered) {
      setTyped(remembered)
      setPrefilled(true)
    }
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const domain = typed.trim()
    if (domain.length === 0) {
      setError('empty')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain }),
      })

      if (response.ok) {
        // The suggestion has done its job; leaving it behind would offer it
        // again on a second store.
        forgetPreviewedDomain()
        onClaimed?.(domain)
        return
      }

      if (response.status === 409) {
        setError('already_claimed')
        return
      }
      setError(response.status === 422 ? 'invalid' : 'failed')
    } catch {
      setError('failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="sortiva-onboarding-card sortiva-connect">
      <h1 className="sortiva-onboarding-card__heading">{t('onboarding.connect.heading')}</h1>
      <p className="sortiva-onboarding-card__body">{t('onboarding.connect.body')}</p>

      <form className="sortiva-connect__form" onSubmit={submit}>
        <label className="sortiva-connect__label" htmlFor="sortiva-connect-domain">
          {t('onboarding.connect.label')}
        </label>
        <input
          id="sortiva-connect-domain"
          className="sortiva-connect__input"
          name="domain"
          type="text"
          inputMode="url"
          autoComplete="url"
          value={typed}
          placeholder={t('onboarding.connect.placeholder')}
          onChange={(event) => {
            setTyped(event.target.value)
            setError(null)
          }}
        />
        <button className="sortiva-connect__submit" type="submit" disabled={submitting}>
          {t('onboarding.connect.submit')}
        </button>
      </form>

      {prefilled ? <p className="sortiva-connect__note">{t('onboarding.connect.prefilled')}</p> : null}

      {error ? (
        <p className="sortiva-connect__error" role="alert" data-claim-error={error}>
          {t(MESSAGES[error])}
          {error === 'already_claimed' ? <a href={supportHref}>{t('onboarding.support')}</a> : null}
        </p>
      ) : null}
    </section>
  )
}
