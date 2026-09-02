import { t as defaultTranslate, type Translate } from '../strings'
import {
  formatElapsed,
  resolveStepper,
  type IngestionStatus,
  type ResolvedOnboardingStep,
} from './steps'

/**
 * The seven-row progress list a merchant watches while their store is read.
 *
 * It draws whatever it is handed and decides nothing: which server-side steps
 * collapse into which row, and when a row starts admitting it is slow, are
 * worked out in `steps.ts` so they can be tested without rendering anything.
 *
 * A failed row is deliberately calm. Failures here retry on their own, so the
 * card says what is happening rather than asking the merchant to do something
 * there is nothing to do about — the only case with an action is a step that
 * has stopped retrying, where a person has to pick it up.
 */

export interface StepperProps {
  readonly status: IngestionStatus | null
  /** The domain being read, for the heading. */
  readonly domain?: string | null
  readonly t?: Translate
  /** Milliseconds since the epoch; passed in so a test can hold the clock still. */
  readonly now?: number
  readonly supportHref?: string
}

const STATE_LABELS = {
  pending: 'onboarding.step.state.pending',
  active: 'onboarding.step.state.active',
  done: 'onboarding.step.state.done',
  failed: 'onboarding.step.state.failed',
  skipped: 'onboarding.step.skipped',
} as const

function StepRow({
  step,
  index,
  t,
  supportHref,
}: {
  step: ResolvedOnboardingStep
  index: number
  t: Translate
  supportHref: string
}) {
  return (
    <li
      className={`sortiva-stepper__row sortiva-stepper__row--${step.state}`}
      data-step={step.id}
      data-step-state={step.state}
    >
      <span className="sortiva-stepper__marker" aria-hidden="true">
        {step.state === 'done' ? '✓' : step.state === 'skipped' ? '✓' : index + 1}
      </span>

      <span className="sortiva-stepper__label">{t(step.labelKey)}</span>

      <span className="sortiva-stepper__state">{t(STATE_LABELS[step.state])}</span>

      {step.skippable && step.state === 'pending' ? (
        <span className="sortiva-stepper__hint">{t('onboarding.step.skippable')}</span>
      ) : null}

      {step.stillWorking ? (
        <span className="sortiva-stepper__hint">{t('onboarding.step.stillWorking')}</span>
      ) : null}

      {step.elapsedMs !== null && step.stillWorking ? (
        <span className="sortiva-stepper__elapsed">{formatElapsed(step.elapsedMs)}</span>
      ) : null}

      {step.state === 'failed' ? (
        <div className="sortiva-stepper__failure" role="status">
          <strong>{t('onboarding.step.failure.heading')}</strong>
          <p>{step.retrying ? t('onboarding.step.failure.body') : t('onboarding.step.failure.stopped')}</p>
          {step.retrying ? null : <a href={supportHref}>{t('onboarding.support')}</a>}
        </div>
      ) : null}
    </li>
  )
}

export function Stepper({
  status,
  domain,
  t = defaultTranslate,
  now,
  supportHref = '/contact',
}: StepperProps) {
  const steps = resolveStepper(status, now === undefined ? {} : { now })

  return (
    <section className="sortiva-stepper" aria-label={t('onboarding.stepper.label')}>
      {domain ? (
        <h1 className="sortiva-stepper__heading">
          {t('onboarding.stepper.heading', { domain })}
        </h1>
      ) : null}
      <ol className="sortiva-stepper__rows" data-stepper-rows={steps.length}>
        {steps.map((step, index) => (
          <StepRow key={step.id} step={step} index={index} t={t} supportHref={supportHref} />
        ))}
      </ol>
    </section>
  )
}
