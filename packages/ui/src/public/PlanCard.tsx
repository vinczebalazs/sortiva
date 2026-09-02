import type { ReactNode } from 'react'
import { t as defaultTranslate, type Translate } from '../strings'
import { formatAmount } from './money'
import { offeredIntervals, priceFor, type BillingInterval, type PlanResponse } from './plan'

/**
 * The one plan, on a card, wherever it is shown — the pricing block on the
 * landing page and the screen that starts a purchase.
 *
 * Two things about it are not the component's to decide. The cap line and the
 * inclusions arrive from the API word for word, because the cap wording is a
 * quality promise the product may not restate ("up to", "quality permitting")
 * and appears identically in Stripe's own product description. And the amount
 * arrives from Stripe, because no price is written down anywhere in this
 * codebase — that is what makes repricing a change in Stripe rather than a
 * deploy.
 *
 * There is no card form here and there never will be: the button hands the
 * browser to Stripe Checkout.
 */

export interface PlanCardProps {
  readonly plan: PlanResponse
  readonly interval: BillingInterval
  /** Omit to render the period as a fixed label rather than a control. */
  readonly onSelectInterval?: (interval: BillingInterval) => void
  /** The button or link that takes the merchant onward. */
  readonly action: ReactNode
  readonly t?: Translate
  /** Overrides the eyebrow above the price; the plan's own name by default. */
  readonly label?: string
  /** The Stripe reassurance line, shown on the purchase screen only. */
  readonly showCardSafety?: boolean
  /** Replaces the amount when Stripe could not be read. */
  readonly priceUnavailable?: boolean
}

const PERIOD_KEY = {
  monthly: 'plan.perMonth',
  annual: 'plan.perYear',
} as const

export function PlanCard({
  plan,
  interval,
  onSelectInterval,
  action,
  t = defaultTranslate,
  label,
  showCardSafety = false,
  priceUnavailable = false,
}: PlanCardProps) {
  const price = priceFor(plan, interval)
  const amount = price && !priceUnavailable ? formatAmount(price) : null
  const intervals = offeredIntervals(plan)

  return (
    <section className="sortiva-plan" data-testid="plan-card" data-interval={interval}>
      <header className="sortiva-plan__head">
        <div>
          <p className="sortiva-plan__label">{label ?? plan.name}</p>
          {amount ? (
            <p className="sortiva-plan__price" data-testid="plan-price">
              <span className="sortiva-plan__amount">{amount}</span>{' '}
              <span className="sortiva-plan__period">{t(PERIOD_KEY[interval])}</span>
            </p>
          ) : (
            <p className="sortiva-plan__price-missing" data-testid="plan-price-unavailable">
              {t('plan.priceUnavailable')}
            </p>
          )}
        </div>

        {onSelectInterval && intervals.length > 1 ? (
          <div
            className="sortiva-plan__intervals"
            role="group"
            aria-label={t('plan.interval.label')}
          >
            {intervals.map((option) => (
              <button
                key={option}
                type="button"
                className="sortiva-plan__interval"
                aria-pressed={option === interval}
                data-interval-option={option}
                onClick={() => onSelectInterval(option)}
              >
                {t(option === 'annual' ? 'plan.interval.annual' : 'plan.interval.monthly')}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      <hr className="sortiva-plan__rule" />

      <p className="sortiva-plan__cap" data-testid="plan-cap-line">
        {plan.capLine}
      </p>

      <ul className="sortiva-plan__inclusions">
        {plan.inclusions.map((inclusion) => (
          <li key={inclusion}>{inclusion}</li>
        ))}
      </ul>

      <div className="sortiva-plan__action">{action}</div>

      <p className="sortiva-plan__cancel">{plan.cancelAnytime}</p>

      {showCardSafety ? (
        <>
          <hr className="sortiva-plan__rule" />
          <p className="sortiva-plan__safety">{t('plan.cardSafety')}</p>
          <ul className="sortiva-plan__facts" data-testid="cancellation-facts">
            {plan.cancellationFacts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}

/**
 * The plan block when Stripe could not be read.
 *
 * The price is the only part that is genuinely missing, so the block still
 * renders: the cap line is the sentence the plan is sold on and it is true
 * whatever the amount turns out to be, and a screen that quietly drops it would
 * be the one place in the product where that promise is not stated. There is no
 * fallback amount because no amount is written down anywhere in this codebase —
 * inventing one on a purchase screen is worse than saying we cannot show it.
 */
export interface PlanUnavailableProps {
  readonly t?: Translate
  readonly label?: string
  /** The onward call to action, where there is one to offer. */
  readonly action?: ReactNode
}

export function PlanUnavailable({ t = defaultTranslate, label, action }: PlanUnavailableProps) {
  return (
    <section className="sortiva-plan" data-testid="plan-card-unavailable">
      <p className="sortiva-plan__label">{label ?? t('landing.pricing.planLabel')}</p>
      <p className="sortiva-plan__price-missing" data-testid="plan-price-unavailable">
        {t('plan.priceUnavailable')}
      </p>
      <p className="sortiva-plan__cap" data-testid="plan-cap-line">
        {t('appendixA.pricingCap')}
      </p>
      {action ? <div className="sortiva-plan__action">{action}</div> : null}
      <p className="sortiva-plan__cancel">{t('billing.cancelAnytime')}</p>
    </section>
  )
}
