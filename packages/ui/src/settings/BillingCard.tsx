'use client'

import { useState } from 'react'
import { formatDate } from '../opportunities/list'
import { t as defaultTranslate, type Translate } from '../strings'
import { billingStatusKey } from './settings'
import type { SettingsAccountView, SettingsPlanView } from './types'

/**
 * ui §9.4's billing card: status, next billing date, "Manage billing" into the
 * Stripe Customer Portal, and the three cancellation facts stated on the card
 * itself rather than only behind a link — main §14.6 asks for that wherever
 * cancellation is offered, and this is one of those places.
 *
 * There is no cancel button here and never will be: cancellation happens in
 * Stripe's own Portal (`packages/core/src/billing/checkout.ts`), which is what
 * "Manage billing" opens.
 */

export interface BillingCardProps {
  readonly subscription: SettingsAccountView['subscription']
  readonly plan: SettingsPlanView
  readonly t?: Translate
  readonly portalEndpoint?: string
}

export function BillingCard({
  subscription,
  plan,
  t = defaultTranslate,
  portalEndpoint = '/api/billing/portal',
}: BillingCardProps) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function openPortal() {
    setBusy(true)
    setFailed(false)
    try {
      const response = await fetch(portalEndpoint, { method: 'POST' })
      if (!response.ok) throw new Error('portal failed')
      const body = (await response.json()) as { url?: string }
      if (!body.url) throw new Error('no redirect')
      window.location.assign(body.url)
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  return (
    <div className="sortiva-settings__billing-card" data-setting="billing">
      <h2>{t('settings.account.billing.heading')}</h2>

      <p className="sortiva-settings__billing-status" data-billing-status={subscription.status}>
        {t(billingStatusKey(subscription.status))}
      </p>

      {subscription.currentPeriodEnd ? (
        <p className="sortiva-settings__note">
          {t('settings.account.billing.nextBillingDate', {
            date: formatDate(subscription.currentPeriodEnd),
          })}
        </p>
      ) : null}

      {subscription.cancelAtPeriodEnd ? (
        <p className="sortiva-settings__note">{t('settings.account.billing.cancelAtPeriodEnd')}</p>
      ) : null}

      <button type="button" disabled={busy} onClick={() => void openPortal()}>
        {t('settings.account.billing.manage')}
      </button>

      {failed ? (
        <p className="sortiva-settings__error" role="alert">
          {t('settings.account.billing.manageFailed')}
        </p>
      ) : null}

      <ul className="sortiva-settings__facts-list" data-testid="cancellation-facts">
        {plan.cancellationFacts.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
    </div>
  )
}
