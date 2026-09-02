'use client'

import { useEffect, useState } from 'react'
import { LimitedIntelligenceBadge } from '../shell'
import { t as defaultTranslate, type StringKey, type Translate } from '../strings'

/**
 * What a merchant lands on when the first scan finishes: the number of ways
 * their store can grow, and — once, ever — one sentence explaining each of the
 * four things the product can do about them.
 *
 * This is the moment the product either lands or does not, which is why the
 * headline is one of the sentences the product may not reword. It is also the
 * only place the four action types are ever explained; every screen afterwards
 * assumes them. So the strip is dismissible and does not come back.
 *
 * A store with no Search Console connection gets the same headline with the
 * Limited Intelligence badge beside it and the connect nudge in place of the
 * last card — because without query data the technical Fix checks are among
 * the things that cannot run, and offering the fix for that is more use than
 * describing a capability the account does not have.
 */

const ACTIONS: readonly { id: string; nameKey: StringKey; bodyKey: StringKey }[] = [
  { id: 'create', nameKey: 'landing.action.create.name', bodyKey: 'activation.create' },
  { id: 'optimize', nameKey: 'landing.action.optimize.name', bodyKey: 'activation.optimize' },
  { id: 'refresh', nameKey: 'landing.action.refresh.name', bodyKey: 'activation.refresh' },
  { id: 'fix', nameKey: 'landing.action.fix.name', bodyKey: 'activation.fix' },
]

/**
 * Where "dismissed for good" is kept. It is per-browser rather than per
 * account: nothing in the API stores a dismissal today, and the cost of
 * getting it wrong is one explainer strip shown twice on a second device,
 * which is a smaller wrong than a column nobody asked for.
 */
const DISMISSED_KEY = 'sortiva.activationExplainerDismissed'

export interface ActivationHeaderProps {
  readonly count: number
  readonly limitedIntelligence?: boolean
  readonly t?: Translate
  readonly connectHref?: string
  /** Forces the strip open or closed; without it the browser's own memory decides. */
  readonly explainerDismissed?: boolean
}

function readDismissed(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(DISMISSED_KEY) === 'true'
  } catch {
    return false
  }
}

export function ActivationHeader({
  count,
  limitedIntelligence = false,
  t = defaultTranslate,
  connectHref = '/settings/connections',
  explainerDismissed,
}: ActivationHeaderProps) {
  const [dismissed, setDismissed] = useState(explainerDismissed ?? false)

  useEffect(() => {
    // Read after mount: the answer lives in the browser, and rendering it on
    // the server would make the first frame disagree with the second.
    if (explainerDismissed === undefined && readDismissed()) setDismissed(true)
  }, [explainerDismissed])

  function dismiss() {
    setDismissed(true)
    try {
      window.localStorage.setItem(DISMISSED_KEY, 'true')
    } catch {
      // A browser refusing storage shows the strip again next time, which is
      // a smaller cost than failing to dismiss it now.
    }
  }

  const cards = limitedIntelligence ? ACTIONS.slice(0, 3) : ACTIONS

  return (
    <header className="sortiva-activation" data-activation-limited={limitedIntelligence ? 'true' : 'false'}>
      <h1 className="sortiva-activation__headline">
        {t('appendixA.opportunityHeadline', { count })}
      </h1>

      {limitedIntelligence ? <LimitedIntelligenceBadge t={t} compact connectHref={connectHref} /> : null}

      {dismissed ? null : (
        <div className="sortiva-activation__explainer" aria-label={t('activation.explainerLabel')}>
          <ul>
            {cards.map((action) => (
              <li key={action.id} data-action-type={action.id}>
                <strong>{t(action.nameKey)}</strong>
                <span>{t(action.bodyKey)}</span>
              </li>
            ))}
            {limitedIntelligence ? (
              <li data-action-type="gsc_nudge">
                <strong>{t('appendixA.gscConnect')}</strong>
                <span>{t('activation.gscNudge')}</span>
                <a href={connectHref}>{t('banner.limitedIntelligence.action')}</a>
              </li>
            ) : null}
          </ul>
          <button type="button" className="sortiva-activation__dismiss" onClick={dismiss}>
            {t('banner.dismiss')}
          </button>
        </div>
      )}
    </header>
  )
}
