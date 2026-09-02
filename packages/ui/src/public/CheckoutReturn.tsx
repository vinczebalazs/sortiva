'use client'

import { useEffect, useState } from 'react'
import { t as defaultTranslate, type Translate } from '../strings'

/**
 * What the merchant sees on coming back from Stripe.
 *
 * **Backed out.** A neutral note that nothing was charged and the account is
 * still there. Backing out of a purchase is not a failure and is not written up
 * as one.
 *
 * **Paid.** Paying does not itself entitle the account: Stripe tells us
 * separately, over a webhook, and the subscription row that decides what the
 * account may do is written there. That usually lands within a second, but it
 * is a different network path and it can lag — so rather than showing an
 * account that appears unpaid, this waits, and says plainly that it is waiting.
 * After half a minute it stops promising it will be quick and says so, without
 * ever suggesting the payment did not go through.
 */

/** How long to wait for the webhook before admitting it is slow. */
export const ENTITLEMENT_WAIT_MS = 30_000
const POLL_INTERVAL_MS = 2000

export type CheckoutOutcome = 'success' | 'canceled'

export function checkoutOutcomeOf(value: string | null | undefined): CheckoutOutcome | null {
  if (value === 'success') return 'success'
  if (value === 'canceled') return 'canceled'
  return null
}

export interface CheckoutCanceledProps {
  readonly t?: Translate
  readonly backHref?: string
}

export function CheckoutCanceled({ t = defaultTranslate, backHref = '/plan' }: CheckoutCanceledProps) {
  return (
    <section className="sortiva-checkout-return" data-testid="checkout-canceled">
      <h2 className="sortiva-checkout-return__title">{t('checkout.canceled.title')}</h2>
      <p className="sortiva-checkout-return__lead">{t('billing.checkoutCanceled')}</p>
      <p className="sortiva-checkout-return__body">{t('checkout.canceled.body')}</p>
      <a className="sortiva-checkout-return__back" href={backHref}>
        {t('checkout.canceled.back')}
      </a>
    </section>
  )
}

export interface EntitlementWaitProps {
  readonly t?: Translate
  /** Where to go once the subscription row says the account is active. */
  readonly onEntitled?: () => void
  readonly endpoint?: string
  readonly waitMs?: number
}

export function CheckoutSettlingUp({
  t = defaultTranslate,
  onEntitled,
  endpoint = '/api/account',
  waitMs = ENTITLEMENT_WAIT_MS,
}: EntitlementWaitProps) {
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    let stopped = false
    const startedAt = Date.now()

    async function poll(): Promise<void> {
      if (stopped) return
      try {
        const response = await fetch(endpoint, { cache: 'no-store' })
        if (response.ok) {
          const body = (await response.json()) as { subscription?: { status?: unknown } }
          if (body.subscription?.status === 'active') {
            if (!stopped) onEntitled?.()
            return
          }
        }
      } catch {
        // A failed poll is indistinguishable from a slow webhook here, and both
        // are handled by waiting; nothing about the payment is in doubt.
      }
      if (stopped) return
      if (Date.now() - startedAt >= waitMs) setSlow(true)
      timer = setTimeout(() => void poll(), POLL_INTERVAL_MS)
    }

    let timer = setTimeout(() => void poll(), 0)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [endpoint, onEntitled, waitMs])

  return (
    <section
      className="sortiva-checkout-return"
      data-testid="checkout-settling"
      data-slow={slow ? 'true' : undefined}
      role="status"
    >
      <h2 className="sortiva-checkout-return__title">{t('checkout.settingUp.title')}</h2>
      <p className="sortiva-checkout-return__body">
        {slow ? t('checkout.settingUp.slow') : t('checkout.settingUp.note')}
      </p>
      <div className="sortiva-checkout-return__bar" aria-hidden="true">
        <span />
      </div>
    </section>
  )
}
