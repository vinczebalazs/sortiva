import type { ReactNode } from 'react'
import { t as defaultTranslate, type Translate } from '../strings'
import { PlanCard } from './PlanCard'
import type { PlanResponse } from './plan'

/**
 * Everything on the landing page below the address field: how the product
 * works, the quality bar it holds itself to, the price, the questions people
 * ask, and the closing invitation.
 *
 * The words are transcribed from the design canvas rather than written here,
 * and they live in the string catalogue like every other sentence — so what
 * ships is what was designed, and a marketing edit is a change to one JSON file
 * rather than to markup.
 *
 * The pricing block shows the same card as the purchase screen, reading the
 * same live amounts from Stripe. A visitor who has not signed up sees no
 * button that would take payment: the call to action is the same sign-up link
 * as everywhere else on the page.
 */

export interface LandingSectionProps {
  readonly t?: Translate
}

const HOW_STEPS = [
  { id: 'find', title: 'landing.how.find.title', body: 'landing.how.find.body' },
  { id: 'act', title: 'landing.how.act.title', body: 'landing.how.act.body' },
  { id: 'learn', title: 'landing.how.learn.title', body: 'landing.how.learn.body' },
] as const

const ACTIONS = [
  { id: 'create', name: 'landing.action.create.name', note: 'landing.action.create.note' },
  { id: 'optimize', name: 'landing.action.optimize.name', note: 'landing.action.optimize.note' },
  { id: 'refresh', name: 'landing.action.refresh.name', note: 'landing.action.refresh.note' },
  { id: 'fix', name: 'landing.action.fix.name', note: 'landing.action.fix.note' },
] as const

const GATES = [
  {
    id: 'gate1',
    label: 'landing.quality.gate1.label',
    title: 'landing.quality.gate1.title',
    body: 'landing.quality.gate1.body',
  },
  {
    id: 'gate2',
    label: 'landing.quality.gate2.label',
    title: 'landing.quality.gate2.title',
    body: 'landing.quality.gate2.body',
  },
  {
    id: 'gate3',
    label: 'landing.quality.gate3.label',
    title: 'landing.quality.gate3.title',
    body: 'landing.quality.gate3.body',
  },
] as const

const FAQ = [
  'approval',
  'editing',
  'emptyDay',
  'platform',
  'writeAccess',
  'searchConsole',
  'bulkAi',
  'cancelling',
] as const

const HEADLINE_STATS = [
  { id: 'gates', value: 'landing.stat.gates.value', note: 'landing.stat.gates.note' },
  { id: 'verdict', value: 'landing.stat.verdict.value', note: 'landing.stat.verdict.note' },
  { id: 'cap', value: 'landing.stat.cap.value', note: 'landing.stat.cap.note' },
] as const

export function LandingHeadlineStats({ t = defaultTranslate }: LandingSectionProps) {
  return (
    <ul className="sortiva-landing__stats">
      {HEADLINE_STATS.map((stat) => (
        <li key={stat.id} className="sortiva-landing__stat">
          <span className="sortiva-landing__stat-value">{t(stat.value)}</span>
          <span className="sortiva-landing__stat-note">{t(stat.note)}</span>
        </li>
      ))}
    </ul>
  )
}

export function LandingHowItWorks({ t = defaultTranslate }: LandingSectionProps) {
  return (
    <section className="sortiva-landing__section" id="how-it-works" data-section="how">
      <p className="sortiva-landing__eyebrow">{t('landing.how.eyebrow')}</p>
      <h2 className="sortiva-landing__heading">{t('landing.how.heading')}</h2>

      <div className="sortiva-landing__grid3">
        {HOW_STEPS.map((step, index) => (
          <article key={step.id} className="sortiva-landing__card">
            {/* Composed rather than written out, so an ordinal never becomes a
                sentence in the catalogue that a translator has to look at. */}
            <span className="sortiva-landing__ordinal" aria-hidden="true">
              {String(index + 1).padStart(2, '0')}
            </span>
            <h3 className="sortiva-landing__card-title">{t(step.title)}</h3>
            <p className="sortiva-landing__card-body">{t(step.body)}</p>
          </article>
        ))}
      </div>

      <div className="sortiva-landing__actions">
        <p className="sortiva-landing__eyebrow">{t('landing.actions.label')}</p>
        <dl className="sortiva-landing__action-list">
          {ACTIONS.map((action) => (
            <div key={action.id} className="sortiva-landing__action" data-action={action.id}>
              <dt>{t(action.name)}</dt>
              <dd>{t(action.note)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}

export function LandingQualityBar({ t = defaultTranslate }: LandingSectionProps) {
  return (
    <section className="sortiva-landing__section" id="quality" data-section="quality">
      <p className="sortiva-landing__eyebrow">{t('landing.quality.eyebrow')}</p>
      <h2 className="sortiva-landing__heading">{t('landing.quality.heading')}</h2>

      <div className="sortiva-landing__grid3">
        {GATES.map((gate) => (
          <article key={gate.id} className="sortiva-landing__card" data-gate={gate.id}>
            <span className="sortiva-landing__tag">{t(gate.label)}</span>
            <h3 className="sortiva-landing__card-title">{t(gate.title)}</h3>
            <p className="sortiva-landing__card-body">{t(gate.body)}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

export interface LandingPricingProps extends LandingSectionProps {
  /**
   * The live plan, or null when Stripe could not be read. The block still
   * renders — the cap line and the reasoning behind it are the point of it —
   * with the amount replaced rather than the section removed.
   */
  readonly plan: PlanResponse | null
  /** The sign-up call to action; the same one the rest of the page uses. */
  readonly action: ReactNode
}

export function LandingPricing({ plan, action, t = defaultTranslate }: LandingPricingProps) {
  return (
    <section className="sortiva-landing__section" id="pricing" data-section="pricing">
      <p className="sortiva-landing__eyebrow">{t('landing.pricing.eyebrow')}</p>

      <div className="sortiva-landing__pricing">
        {plan ? (
          <PlanCard
            plan={plan}
            interval="monthly"
            label={t('landing.pricing.planLabel')}
            action={action}
            t={t}
          />
        ) : (
          <section className="sortiva-plan" data-testid="plan-card-unavailable">
            <p className="sortiva-plan__label">{t('landing.pricing.planLabel')}</p>
            <p className="sortiva-plan__price-missing">{t('plan.priceUnavailable')}</p>
            {/* The cap line is the sentence this block exists to state, so it
                survives Stripe being unreadable. */}
            <p className="sortiva-plan__cap" data-testid="plan-cap-line">
              {t('appendixA.pricingCap')}
            </p>
            <div className="sortiva-plan__action">{action}</div>
          </section>
        )}

        <div className="sortiva-landing__pricing-aside">
          <h3 className="sortiva-landing__card-title">{t('landing.pricing.asideHeading')}</h3>
          <p className="sortiva-landing__card-body">{t('landing.pricing.aside1')}</p>
          <p className="sortiva-landing__card-body">{t('landing.pricing.aside2')}</p>
        </div>
      </div>
    </section>
  )
}

export function LandingFaq({ t = defaultTranslate }: LandingSectionProps) {
  return (
    <section className="sortiva-landing__section" id="faq" data-section="faq">
      <p className="sortiva-landing__eyebrow">{t('landing.faq.eyebrow')}</p>
      <h2 className="sortiva-landing__heading">{t('landing.faq.heading')}</h2>

      <div className="sortiva-landing__faq">
        {FAQ.map((entry) => (
          <article key={entry} className="sortiva-landing__card" data-faq={entry}>
            <h3 className="sortiva-landing__card-title">
              {t(`landing.faq.${entry}.question` as never)}
            </h3>
            <p className="sortiva-landing__card-body">
              {t(`landing.faq.${entry}.answer` as never)}
            </p>
          </article>
        ))}
      </div>
    </section>
  )
}

export interface LandingClosingProps extends LandingSectionProps {
  readonly action: ReactNode
  /** Sends the visitor back up to the address field rather than to a new page. */
  readonly previewHref?: string
}

export function LandingClosing({
  action,
  previewHref = '#preview',
  t = defaultTranslate,
}: LandingClosingProps) {
  return (
    <section className="sortiva-landing__closing" data-section="closing">
      <h2 className="sortiva-landing__heading">{t('landing.cta.heading')}</h2>
      <div className="sortiva-landing__closing-actions">
        {action}
        <a className="sortiva-landing__secondary" href={previewHref}>
          {t('landing.cta.analyzeFirst')}
        </a>
      </div>
    </section>
  )
}

export interface LandingFooterProps extends LandingSectionProps {
  readonly privacyHref?: string
  readonly termsHref?: string
  readonly contactHref?: string
}

export function LandingFooter({
  t = defaultTranslate,
  privacyHref = '/privacy',
  termsHref = '/terms',
  contactHref = '/contact',
}: LandingFooterProps) {
  return (
    <footer className="sortiva-landing__footer">
      <span className="sortiva-landing__brand">{t('nav.brand')}</span>
      <nav aria-label={t('landing.footer.label')}>
        <a href="#pricing">{t('landing.nav.pricing')}</a>
        <a href={privacyHref}>{t('landing.footer.privacy')}</a>
        <a href={termsHref}>{t('landing.footer.terms')}</a>
        <a href={contactHref}>{t('landing.footer.contact')}</a>
      </nav>
    </footer>
  )
}

export interface LandingHeaderProps extends LandingSectionProps {
  readonly signinHref?: string
}

export function LandingHeader({ t = defaultTranslate, signinHref = '/signin' }: LandingHeaderProps) {
  return (
    <header className="sortiva-landing__header">
      <span className="sortiva-landing__brand">{t('nav.brand')}</span>
      <nav className="sortiva-landing__nav" aria-label={t('landing.nav.label')}>
        <a href="#how-it-works">{t('landing.nav.howItWorks')}</a>
        <a href="#quality">{t('landing.nav.quality')}</a>
        <a href="#pricing">{t('landing.nav.pricing')}</a>
        <a href="#faq">{t('landing.nav.faq')}</a>
      </nav>
      <div className="sortiva-landing__header-actions">
        <a className="sortiva-landing__secondary" href={signinHref}>
          {t('landing.nav.logIn')}
        </a>
        <a className="sortiva-landing__primary" href={signinHref} data-testid="get-started">
          {t('landing.nav.getStarted')}
        </a>
      </div>
    </header>
  )
}
