'use client'

import { t as defaultTranslate, type Translate } from '../strings'
import {
  actionLabel,
  confidenceLabel,
  entityLabel,
  evidenceLine,
  impactLabel,
  optimizeCapNote,
  preconditionLabel,
  primaryAction,
  signalLabel,
  statusChip,
  type PrimaryAction,
  type PrimaryActionContext,
} from './list'
import type { OpportunityRow } from './types'
import { renderTemplatedLine } from './why'

/**
 * One thing the merchant could do about their store, with everything needed to
 * judge it without opening anything.
 *
 * The action badge comes first because it is the answer to "what do I do";
 * impact and confidence follow as neutral pills so the colour on the badge
 * keeps meaning something. Then the numbers with where they came from, then
 * one sentence of reasoning, then one button.
 *
 * The confidence pill carries its own arithmetic: the merchant can see which
 * facts raised the number and which lowered it, because a confidence score
 * nobody can interrogate is just a mood.
 */

export interface OpportunityCardProps {
  readonly opportunity: OpportunityRow
  readonly t?: Translate
  readonly context?: PrimaryActionContext
  readonly onPrimary?: (opportunity: OpportunityRow, action: PrimaryAction) => void
  readonly onDismiss?: (opportunity: OpportunityRow) => void
  readonly onDetails?: (opportunity: OpportunityRow) => void
  /** Set while the card's own request is in flight, so it cannot be fired twice. */
  readonly busy?: boolean
}

export function OpportunityCard({
  opportunity,
  t = defaultTranslate,
  context,
  onPrimary,
  onDismiss,
  onDetails,
  busy = false,
}: OpportunityCardProps) {
  const action = primaryAction(opportunity, t, context)
  const evidence = evidenceLine(opportunity.evidence, t)
  const why = renderTemplatedLine(opportunity.why, t)
  const chip = statusChip(opportunity, t)
  const blocked = opportunity.preconditions[0]

  return (
    <article
      className="sortiva-opp"
      data-opportunity-id={opportunity.id}
      data-action={opportunity.recommendedAction}
      data-impact={opportunity.impact}
      data-confidence={opportunity.confidence}
      data-signal={opportunity.signalType}
      data-status={opportunity.status}
    >
      <div className="sortiva-opp__pills">
        <span className="sortiva-opp__badge" data-opp-badge={opportunity.recommendedAction}>
          {actionLabel(opportunity.recommendedAction, t)}
        </span>
        <span className="sortiva-opp__pill" data-opp-impact={opportunity.impact}>
          {impactLabel(opportunity.impact, t)}
        </span>
        <span className="sortiva-opp__pill" data-opp-confidence={opportunity.confidence}>
          {confidenceLabel(opportunity.confidence, t)}
        </span>
        <span className="sortiva-opp__tag" data-opp-signal={opportunity.signalType}>
          {signalLabel(opportunity.signalType, t)}
        </span>
        <span className="sortiva-opp__tag" data-opp-entity={opportunity.entityRef.kind}>
          {entityLabel(opportunity.entityRef.kind, t)}
        </span>
        {chip ? (
          <span className="sortiva-opp__chip" data-opp-chip={opportunity.status}>
            {chip}
          </span>
        ) : null}
      </div>

      {/* The title opens the drawer as well as the Details button: the entity
          is what a merchant recognises, so it is what they click. */}
      <h3 className="sortiva-opp__title">
        <button
          type="button"
          className="sortiva-opp__title-button"
          onClick={() => onDetails?.(opportunity)}
        >
          {opportunity.entityRef.label}
        </button>
      </h3>

      {evidence ? <p className="sortiva-opp__evidence">{evidence}</p> : null}

      <p className="sortiva-opp__why" data-why-known={why.known ? 'true' : 'false'}>
        {why.text}
      </p>

      {blocked ? (
        <p className="sortiva-opp__ribbon" data-opp-precondition={blocked.code}>
          {t('opportunities.blocked', {
            precondition: preconditionLabel(blocked.code, t),
            whatToDo: renderTemplatedLine(blocked.whatToDo, t).text,
          })}
        </p>
      ) : null}

      {opportunity.limitedIntelligence ? (
        <p className="sortiva-opp__proxy">{t('opportunities.estimatedRanking')}</p>
      ) : null}

      <div className="sortiva-opp__actions">
        {action ? (
          action.href ? (
            <a className="sortiva-opp__primary" href={action.href} data-opp-action={action.kind}>
              {action.label}
            </a>
          ) : (
            <button
              type="button"
              className="sortiva-opp__primary"
              data-opp-action={action.kind}
              disabled={action.disabled || busy}
              onClick={() => onPrimary?.(opportunity, action)}
            >
              {action.label}
            </button>
          )
        ) : null}

        <button
          type="button"
          className="sortiva-opp__secondary"
          data-opp-action="details"
          onClick={() => onDetails?.(opportunity)}
        >
          {t('opportunities.details')}
        </button>

        <button
          type="button"
          className="sortiva-opp__secondary"
          data-opp-action="dismiss"
          disabled={busy}
          onClick={() => onDismiss?.(opportunity)}
        >
          {t('opportunities.dismiss')}
        </button>

        {context?.capReached && opportunity.recommendedAction === 'OPTIMIZE' ? (
          <span className="sortiva-opp__note">{optimizeCapNote(t, context.optimizeDailyCap)}</span>
        ) : null}

        {opportunity.status === 'accepted' &&
        (opportunity.recommendedAction === 'CREATE' || opportunity.recommendedAction === 'REFRESH') &&
        !opportunity.scheduledFor ? (
          <span className="sortiva-opp__note">{t('opportunities.autoAccepted')}</span>
        ) : null}
      </div>

      {opportunity.confidenceFactors.length > 0 ? (
        <details className="sortiva-opp__confidence">
          <summary>{t('opportunities.confidenceHeading')}</summary>
          <ul>
            {opportunity.confidenceFactors.map((factor) => (
              <li key={factor.label} data-confidence-direction={factor.direction}>
                {factor.label}
                {/* The direction is a colour and an arrow in the design; this
                    says the same thing to a screen reader. */}
                <span className="sortiva-visually-hidden">
                  {factor.direction === 'up'
                    ? t('opportunities.confidenceRaised')
                    : t('opportunities.confidenceLowered')}
                </span>
              </li>
            ))}
          </ul>
          <p>{t('opportunities.confidenceDeterministic')}</p>
        </details>
      ) : null}
    </article>
  )
}
