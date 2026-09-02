'use client'

import { t as defaultTranslate, type Translate } from '../strings'
import { renderTemplatedLine } from '../opportunities/why'
import { formatDate } from '../opportunities/list'
import { gateLabel } from './calendar'
import type { TemplatedLine } from '../opportunities/types'

/**
 * Why something we planned did not get published, said plainly.
 *
 * The same card appears on a held calendar day, on the article that was held,
 * and in the notification list, because a merchant should meet the same
 * sentence wherever they run into the outcome. Naming the check that stopped it
 * is the point: a day that produced nothing with no explanation reads as a
 * product that quietly failed, and this is the surface where the opposite is
 * demonstrated.
 *
 * The reason is a key and a bag of numbers the engine measured, filled in from
 * the string catalogue. Nothing a language model wrote appears here — a
 * beautifully worded reason that was quietly wrong about the merchant's own
 * store is the failure mode this rules out.
 */

export interface RejectionCardProps {
  readonly gate: string
  readonly reason: TemplatedLine
  /** The day it was held, where there is one. */
  readonly date?: string | null
  /** Rendered as a link to the draft, where one is viewable. */
  readonly draftHref?: string | null
  readonly t?: Translate
}

export function RejectionCard({
  gate,
  reason,
  date = null,
  draftHref = null,
  t = defaultTranslate,
}: RejectionCardProps) {
  const line = renderTemplatedLine(reason, t)

  return (
    <section className="sortiva-rejection" data-rejection-gate={gate}>
      <h4 className="sortiva-rejection__heading">
        {date ? t('content.rejection.heading', { date: formatDate(date) }) : t('content.rejection.headingPlain')}
      </h4>
      <p className="sortiva-rejection__gate">{t('content.rejection.gate', { gate: gateLabel(gate, t) })}</p>
      <p className="sortiva-rejection__reason" data-why-known={line.known ? 'true' : 'false'}>
        {line.text}
      </p>
      {draftHref ? (
        <a className="sortiva-rejection__link" href={draftHref}>
          {t('content.rejection.viewDraft')}
        </a>
      ) : null}
    </section>
  )
}
