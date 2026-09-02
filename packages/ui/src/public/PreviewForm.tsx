'use client'

import { useCallback, useRef, useState, type FormEvent } from 'react'
import { t as defaultTranslate, type Translate } from '../strings'
import { Turnstile } from './Turnstile'
import { PreviewCard, signupHrefFor } from './PreviewCard'
import { isSubmittable, previewStateFrom, type PreviewOutcome, type PreviewState } from './preview-state'

/**
 * The address field on the landing page, and the card it produces.
 *
 * This is the product's only unauthenticated surface and its whole job is to
 * convert a visitor. So every failure — a site that will not load, a bot check
 * that never issued a token, our own endpoint being down — ends on the same
 * card inviting them to sign up. The one message that says anything else is
 * being rate-limited, because waiting a minute is something the visitor can
 * actually do.
 */

/** How long a submit waits for the bot check to hand over a token. */
const TOKEN_GRACE_MS = 3000
const TOKEN_POLL_MS = 100

export interface PreviewFormProps {
  /**
   * Cloudflare's public site key, read from the server's configuration and
   * passed in. Absent in a development environment with no Cloudflare account:
   * the widget then does not render, the request goes without a token, and the
   * endpoint declines it — which the visitor sees as the fallback card.
   */
  readonly turnstileSiteKey?: string | null
  readonly endpoint?: string
  readonly t?: Translate
  /** Where the teaser leads; the previewed domain is appended to it. */
  readonly signinHref?: string
}

export function PreviewForm({
  turnstileSiteKey,
  endpoint = '/api/preview',
  t = defaultTranslate,
  signinHref,
}: PreviewFormProps) {
  const [typed, setTyped] = useState('')
  const [state, setState] = useState<PreviewState>({ kind: 'idle' })
  const [emptySubmit, setEmptySubmit] = useState(false)
  const token = useRef<string | null>(null)

  const waitForToken = useCallback(async (): Promise<string> => {
    if (!turnstileSiteKey) return ''
    const deadline = Date.now() + TOKEN_GRACE_MS
    while (token.current === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, TOKEN_POLL_MS))
    }
    return token.current ?? ''
  }, [turnstileSiteKey])

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault()
      if (!isSubmittable(typed)) {
        setEmptySubmit(true)
        return
      }
      setEmptySubmit(false)
      setState({ kind: 'loading', typed })

      const turnstileToken = await waitForToken()
      let outcome: PreviewOutcome
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: typed.trim(), turnstileToken }),
        })
        outcome = { kind: 'answered', status: response.status, body: await response.json() }
      } catch {
        outcome = { kind: 'unreachable' }
      }

      setState(previewStateFrom(outcome, typed.trim()))
    },
    [endpoint, typed, waitForToken],
  )

  const busy = state.kind === 'loading'

  return (
    <div className="sortiva-preview-form">
      <form className="sortiva-preview-form__row" onSubmit={submit} data-testid="preview-form">
        <label className="sortiva-preview-form__label" htmlFor="sortiva-preview-url">
          {t('landing.hero.urlLabel')}
        </label>
        <input
          className="sortiva-preview-form__input"
          id="sortiva-preview-url"
          name="url"
          type="text"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          placeholder={t('landing.hero.urlPlaceholder')}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        <button className="sortiva-preview-form__submit" type="submit" disabled={busy}>
          {t('landing.hero.analyze')}
        </button>
      </form>

      {turnstileSiteKey ? (
        <Turnstile
          siteKey={turnstileSiteKey}
          onToken={(value) => {
            token.current = value
          }}
        />
      ) : null}

      <p className="sortiva-preview-form__note">{t('landing.hero.turnstileNote')}</p>

      {emptySubmit ? (
        <p className="sortiva-preview-form__hint" role="alert">
          {t('preview.emptyUrl')}
        </p>
      ) : null}

      <PreviewCard
        state={state}
        t={t}
        signupHref={signinHref ? signupHrefFor(state, signinHref) : undefined}
      />
    </div>
  )
}
