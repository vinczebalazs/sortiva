'use client'

import { useCallback } from 'react'
import {
  CheckoutCanceled,
  CheckoutSettlingUp,
  PlanPurchase,
  PlanUnavailable,
  checkoutOutcomeOf,
  t,
  type CheckoutOutcome,
  type PlanResponse,
} from '@sortiva/ui'

/**
 * One plan, one button, and no card form — the button hands the browser to
 * Stripe Checkout, which is the whole reason we never render one.
 *
 * The same screen shows what a merchant comes back to. Backing out of a
 * purchase is not a failure and is not written up as one. Paying is not the
 * moment the account becomes entitled either: Stripe tells us separately over a
 * webhook, and the row that decides what the account may do is written there —
 * usually within a second, sometimes not — so the screen waits and says plainly
 * that it is waiting.
 */

export interface PlanScreenProps {
  readonly plan: PlanResponse | null
  /** `?checkout=success` or `?checkout=canceled`, as Stripe sends the browser back. */
  readonly returned: string | null
  readonly onEntitledHref?: string
}

const STEPS = ['plan.step.plan', 'plan.step.domain', 'plan.step.review', 'plan.step.opportunities'] as const

export function PlanScreen({ plan, returned, onEntitledHref = '/dashboard' }: PlanScreenProps) {
  const outcome: CheckoutOutcome | null = checkoutOutcomeOf(returned)

  const entitled = useCallback(() => {
    window.location.assign(onEntitledHref)
  }, [onEntitledHref])

  if (outcome === 'success') {
    return (
      <main className="sortiva-narrow">
        <CheckoutSettlingUp onEntitled={entitled} />
      </main>
    )
  }

  return (
    <main className="sortiva-public__width">
      <div className="sortiva-plan-screen">
        <div>
          <ol className="sortiva-plan-screen__steps" aria-label={t('plan.steps.label')}>
            {STEPS.map((step, index) => (
              <li
                key={step}
                className="sortiva-plan-screen__step"
                aria-current={index === 0 ? 'step' : undefined}
              >
                {t(step)}
              </li>
            ))}
          </ol>

          <h1 className="sortiva-landing__heading">{t('plan.heading')}</h1>

          {plan ? <PlanPurchase plan={plan} /> : <PlanUnavailable />}
        </div>

        <div>
          {outcome === 'canceled' ? (
            <CheckoutCanceled backHref="/plan" />
          ) : null}
        </div>
      </div>
    </main>
  )
}
