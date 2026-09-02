'use client'

import { useCallback, useState } from 'react'
import { t as defaultTranslate, type Translate } from '../strings'
import { PlanCard } from './PlanCard'
import type { BillingInterval, PlanResponse } from './plan'

/**
 * The plan screen's single button.
 *
 * It creates a Stripe Checkout session and hands the browser to the URL Stripe
 * returns. Nothing about a card is typed, stored or even rendered here — that
 * is the whole reason Checkout is used, and it keeps a payment form out of the
 * product entirely.
 *
 * Entitlement is not decided here either. Paying starts a webhook that writes
 * the subscription row; this screen only opens the till.
 *
 * The plan card is readable without an account — the prices it shows are the
 * ones Stripe would show anyway — so a visitor can arrive here straight off the
 * landing page. Pressing the button is the first thing that needs an identity,
 * and the endpoint says so with a 401; that sends them to sign in rather than
 * telling them the payment page is broken.
 */

export interface PlanPurchaseProps {
  readonly plan: PlanResponse
  /** Absent when Stripe could not be read; the button is then unusable. */
  readonly pricesAvailable?: boolean
  readonly endpoint?: string
  readonly t?: Translate
  /** Where an unauthenticated visitor is sent to sign in before paying. */
  readonly signinHref?: string
  /** Injected by tests so the flow can be exercised without leaving the page. */
  readonly navigate?: (url: string) => void
}

/** The endpoint's answer when there is no session behind the request. */
const UNAUTHENTICATED_STATUS = 401

export function PlanPurchase({
  plan,
  pricesAvailable = true,
  endpoint = '/api/billing/checkout',
  t = defaultTranslate,
  signinHref = '/signin',
  navigate,
}: PlanPurchaseProps) {
  const [interval, setInterval] = useState<BillingInterval>('monthly')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const subscribe = useCallback(async () => {
    setBusy(true)
    setFailed(false)
    const go = navigate ?? ((url: string) => window.location.assign(url))
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ interval }),
      })
      if (response.status === UNAUTHENTICATED_STATUS) {
        go(`${signinHref}?next=${encodeURIComponent(planPath())}`)
        return
      }
      const body = (await response.json()) as { url?: unknown }
      if (!response.ok || typeof body.url !== 'string') {
        setFailed(true)
        setBusy(false)
        return
      }
      go(body.url)
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }, [endpoint, interval, navigate, signinHref])

  return (
    <div className="sortiva-plan-purchase">
      <PlanCard
        plan={plan}
        interval={interval}
        onSelectInterval={setInterval}
        t={t}
        showCardSafety
        priceUnavailable={!pricesAvailable}
        action={
          <button
            type="button"
            className="sortiva-plan__subscribe"
            data-testid="subscribe"
            disabled={busy || !pricesAvailable}
            onClick={subscribe}
          >
            {t('plan.subscribe')}
          </button>
        }
      />
      {failed ? (
        <p className="sortiva-plan__error" role="alert" data-testid="checkout-failed">
          {t('plan.checkoutFailed')}
        </p>
      ) : null}
    </div>
  )
}

/** Where to come back to after signing in: this screen, wherever it is mounted. */
function planPath(): string {
  if (typeof window === 'undefined') return '/plan'
  return `${window.location.pathname}${window.location.search}`
}
