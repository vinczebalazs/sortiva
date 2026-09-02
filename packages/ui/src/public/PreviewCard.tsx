import { t as defaultTranslate, type Translate } from '../strings'
import type { PreviewState } from './preview-state'

/**
 * The card under the landing page's address field, in each of the four things
 * it can be: nothing yet, reading, what we understood, and the graceful
 * fallback.
 *
 * Three of those four end in the same invitation to sign up. That is the whole
 * point of the surface — a visitor whose site we failed to read is exactly as
 * worth converting as one whose site we read perfectly, so the failure carries
 * the same call to action rather than an apology.
 */

export interface PreviewCardProps {
  readonly state: PreviewState
  readonly t?: Translate
  /**
   * Where the teaser goes. The previewed domain rides along so the connect step
   * can pre-fill it — pre-fill only; a domain is never claimed on a visitor's
   * behalf.
   */
  readonly signupHref?: string
}

export function signupHrefFor(state: PreviewState, base = '/signin'): string {
  const domain = state.kind === 'result' || state.kind === 'generic' ? state.domain : ''
  if (!domain) return base
  return `${base}?domain=${encodeURIComponent(domain)}`
}

function Teaser({ href, t }: { href: string; t: Translate }) {
  return (
    <a className="sortiva-preview__teaser" href={href} data-testid="preview-teaser">
      {t('appendixA.landingPreviewTeaser')}
    </a>
  )
}

export function PreviewCard({ state, t = defaultTranslate, signupHref }: PreviewCardProps) {
  const href = signupHref ?? signupHrefFor(state)

  if (state.kind === 'idle') return null

  if (state.kind === 'loading') {
    return (
      <div className="sortiva-preview sortiva-preview--loading" data-preview-state="loading">
        <p className="sortiva-preview__status" role="status">
          {t('preview.loading')}
        </p>
        <div className="sortiva-preview__skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
    )
  }

  if (state.kind === 'rate_limited') {
    return (
      <div className="sortiva-preview sortiva-preview--limited" data-preview-state="rate_limited">
        <p className="sortiva-preview__status" role="status">
          {t('preview.rateLimited')}
        </p>
      </div>
    )
  }

  if (state.kind === 'generic') {
    return (
      <div className="sortiva-preview sortiva-preview--generic" data-preview-state="generic">
        <p className="sortiva-preview__body">{t('preview.generic')}</p>
        <Teaser href={href} t={t} />
      </div>
    )
  }

  return (
    <div className="sortiva-preview sortiva-preview--result" data-preview-state="result">
      <p className="sortiva-preview__label">{t('preview.resultLabel')}</p>
      <h3 className="sortiva-preview__heading">
        {t('preview.resultHeading', { domain: state.domain })}
      </h3>
      <p className="sortiva-preview__body">{state.summary}</p>
      <Teaser href={href} t={t} />
    </div>
  )
}
