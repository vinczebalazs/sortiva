'use client'

import { useCallback, useEffect, useState } from 'react'
import { t as defaultTranslate, type Translate } from '../strings'

/**
 * The Search Console step: the one part of setting up a store that a merchant
 * may decline.
 *
 * It is not a blocker, and it is not silently optional either. Proving you own
 * a site in Google's console is real friction, and a merchant should see what
 * the product does without it — so "Skip for now" is always on screen and
 * carries the same weight in words as connecting does. What it does not carry
 * is the same weight in colour, because connecting is what we recommend, and
 * the card says plainly what skipping costs: opportunities then come from the
 * catalogue and the market alone.
 *
 * Picking a property is where a merchant can go wrong in a way we can catch. A
 * Google account often reads several sites; choosing the wrong one would fill
 * this store's intelligence with somebody else's traffic. So a property whose
 * host is not the claimed domain is shown, labelled, and cannot be selected.
 */

export interface GscProperty {
  readonly siteUrl: string
  readonly permissionLevel: string
  readonly matchesClaimedDomain: boolean
}

export interface SearchConsoleStepProps {
  readonly t?: Translate
  /**
   * `picker` when the merchant has just come back from Google and still has to
   * say which site this is. `connect` otherwise.
   */
  readonly initialPhase?: 'connect' | 'picker'
  readonly startEndpoint?: string
  readonly propertiesEndpoint?: string
  readonly selectEndpoint?: string
  readonly skipEndpoint?: string
  /** Called once the step is settled, so the page can re-read the run. */
  readonly onSettled?: (outcome: 'connected' | 'skipped') => void
}

type Phase = 'connect' | 'loading' | 'picker' | 'backfilling' | 'skipped'

const BENEFITS = [
  'onboarding.gsc.benefit.performance',
  'onboarding.gsc.benefit.ctr',
  'onboarding.gsc.benefit.decay',
  'onboarding.gsc.benefit.cannibalization',
] as const

/** Google writes a whole-domain property as `sc-domain:example.com`; anything else is a URL prefix. */
function isDomainProperty(siteUrl: string): boolean {
  return siteUrl.startsWith('sc-domain:')
}

export function SearchConsoleStep({
  t = defaultTranslate,
  initialPhase = 'connect',
  startEndpoint = '/api/gsc/oauth/start',
  propertiesEndpoint = '/api/gsc/properties',
  selectEndpoint = '/api/gsc/property',
  skipEndpoint = '/api/gsc/skip',
  onSettled,
}: SearchConsoleStepProps) {
  const [phase, setPhase] = useState<Phase>(initialPhase === 'picker' ? 'loading' : 'connect')
  const [properties, setProperties] = useState<readonly GscProperty[]>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const loadProperties = useCallback(async () => {
    setFailed(false)
    try {
      const response = await fetch(propertiesEndpoint)
      if (!response.ok) throw new Error('properties unavailable')
      const body = (await response.json()) as { properties: readonly GscProperty[] }
      setProperties(body.properties)
      setPhase('picker')
    } catch {
      setFailed(true)
      setPhase('connect')
    }
  }, [propertiesEndpoint])

  useEffect(() => {
    if (initialPhase === 'picker') void loadProperties()
  }, [initialPhase, loadProperties])

  async function connect() {
    setBusy(true)
    setFailed(false)
    try {
      const response = await fetch(startEndpoint, { method: 'POST' })
      if (!response.ok) throw new Error('oauth start failed')
      const body = (await response.json()) as { url?: string }
      if (!body.url) throw new Error('no redirect')
      window.location.assign(body.url)
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  async function select(siteUrl: string) {
    setBusy(true)
    setFailed(false)
    try {
      const response = await fetch(selectEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ siteUrl }),
      })
      if (!response.ok) throw new Error('selection failed')
      // The sixteen-month import keeps running after this; the run does not
      // wait for it, and neither does the merchant.
      setPhase('backfilling')
      onSettled?.('connected')
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  async function skip() {
    setBusy(true)
    setFailed(false)
    try {
      const response = await fetch(skipEndpoint, { method: 'POST' })
      if (!response.ok) throw new Error('skip failed')
      setPhase('skipped')
      onSettled?.('skipped')
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  if (phase === 'backfilling') {
    return (
      <section className="sortiva-onboarding-card sortiva-gsc" data-onboarding-card="gsc_backfilling">
        <p className="sortiva-gsc__backfill">{t('onboarding.gsc.backfill')}</p>
      </section>
    )
  }

  if (phase === 'skipped') {
    return (
      <section className="sortiva-onboarding-card sortiva-gsc" data-onboarding-card="gsc_skipped">
        <p className="sortiva-gsc__skipped">{t('onboarding.step.skipped')}</p>
      </section>
    )
  }

  return (
    <section className="sortiva-onboarding-card sortiva-gsc" data-onboarding-card="gsc_connect">
      <h1 className="sortiva-onboarding-card__heading">{t('appendixA.gscConnect')}</h1>

      <ul className="sortiva-gsc__benefits">
        {BENEFITS.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>

      <p className="sortiva-gsc__consequence">{t('onboarding.gsc.consequence')}</p>

      {phase === 'picker' ? (
        <div className="sortiva-gsc__picker">
          <h2 className="sortiva-gsc__picker-heading">{t('onboarding.gsc.picker.heading')}</h2>
          {properties.length === 0 ? (
            <p className="sortiva-gsc__picker-empty">{t('onboarding.gsc.picker.empty')}</p>
          ) : (
            <ul aria-label={t('onboarding.gsc.picker.label')}>
              {properties.map((property) => (
                <li
                  key={property.siteUrl}
                  data-property-selectable={property.matchesClaimedDomain ? 'true' : 'false'}
                >
                  <code>{property.siteUrl}</code>
                  <span className="sortiva-gsc__picker-kind">
                    {isDomainProperty(property.siteUrl)
                      ? t('onboarding.gsc.picker.domainProperty')
                      : t('onboarding.gsc.picker.urlPrefix')}
                  </span>
                  {property.matchesClaimedDomain ? (
                    <button type="button" disabled={busy} onClick={() => select(property.siteUrl)}>
                      {t('onboarding.gsc.picker.select')}
                    </button>
                  ) : (
                    <span className="sortiva-gsc__picker-mismatch">
                      {t('onboarding.gsc.picker.mismatch')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="sortiva-gsc__picker-note">{t('onboarding.gsc.picker.note')}</p>
        </div>
      ) : (
        <button
          className="sortiva-onboarding-card__primary"
          type="button"
          onClick={connect}
          disabled={busy || phase === 'loading'}
        >
          {t('onboarding.gsc.connect')}
        </button>
      )}

      <button className="sortiva-gsc__skip" type="button" onClick={skip} disabled={busy}>
        {t('onboarding.gsc.skip')}
      </button>

      {failed ? (
        <p className="sortiva-onboarding-card__error" role="alert">
          {t('onboarding.gsc.failed')}
        </p>
      ) : null}
    </section>
  )
}
