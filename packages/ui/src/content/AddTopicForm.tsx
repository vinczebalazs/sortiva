'use client'

import { useState } from 'react'
import { t as defaultTranslate, type Translate } from '../strings'
import { formatDate } from '../opportunities/list'
import { renderTemplatedLine } from '../opportunities/why'
import type { AddTopicResponse } from './types'

/**
 * A topic the merchant thought of, put through the same admission check as one
 * we chose.
 *
 * That is the honesty the form is built around: choosing the subject is the
 * merchant's, saying whether anyone is searching for it is ours, and the answer
 * comes back as one of four rather than as a yes. It can proceed; it can
 * proceed with a warning that nobody is searching for that phrasing; it can
 * turn out we already rank for it, in which case the topic becomes a
 * page-improvement opportunity instead of a second page competing with the
 * first; or it can be refused with the reason.
 *
 * The chip is in `checking` on the calendar while this runs, so the answer
 * lands where the merchant is already looking.
 */

export interface AddTopicFormProps {
  /** The day the ghost "+" was pressed on. */
  readonly date: string
  readonly t?: Translate
  readonly opportunityHref?: string
  readonly onSubmit: (input: { title: string; date: string; pin: boolean }) => Promise<AddTopicResponse | null>
  readonly onClose: () => void
}

export function AddTopicForm({
  date,
  t = defaultTranslate,
  opportunityHref = '/opportunities',
  onSubmit,
  onClose,
}: AddTopicFormProps) {
  const [title, setTitle] = useState('')
  const [pin, setPin] = useState(false)
  const [checking, setChecking] = useState(false)
  const [answer, setAnswer] = useState<AddTopicResponse | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (checking || title.trim() === '') return
    setChecking(true)
    setAnswer(await onSubmit({ title: title.trim(), date, pin }))
    setChecking(false)
  }

  return (
    <div
      className="sortiva-add-topic"
      role="dialog"
      aria-label={t('content.add.title')}
      data-add-topic-date={date}
      data-add-state={checking ? 'checking' : (answer?.outcome ?? 'idle')}
    >
      <h3 className="sortiva-add-topic__title">{t('content.add.title')}</h3>
      <p className="sortiva-add-topic__intro">{t('content.add.intro')}</p>

      <form onSubmit={(event) => void submit(event)}>
        <label className="sortiva-content-field">
          <span className="sortiva-content-field__label">{t('content.add.topicLabel')}</span>
          <input
            className="sortiva-content-field__input"
            name="title"
            value={title}
            placeholder={t('content.add.topicPlaceholder')}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <p className="sortiva-add-topic__date">
          {t('content.add.dateLabel')}
          <span data-add-topic-day>{formatDate(date)}</span>
        </p>

        <label className="sortiva-content-field sortiva-content-field--check">
          <input type="checkbox" checked={pin} onChange={(event) => setPin(event.target.checked)} />
          <span>{t('content.add.pinLabel')}</span>
        </label>

        <div className="sortiva-add-topic__actions">
          <button type="submit" className="sortiva-content-button sortiva-content-button--primary" disabled={checking || title.trim() === ''}>
            {t('content.add.submit')}
          </button>
          <button type="button" className="sortiva-content-button" onClick={onClose}>
            {answer ? t('content.add.close') : t('content.add.cancel')}
          </button>
        </div>
      </form>

      {checking ? (
        <p className="sortiva-add-topic__checking" data-add-checking>
          {t('content.add.checking')}
        </p>
      ) : null}

      {answer && !checking ? <AddTopicAnswer answer={answer} t={t} opportunityHref={opportunityHref} /> : null}
    </div>
  )
}

function AddTopicAnswer({
  answer,
  t,
  opportunityHref,
}: {
  answer: AddTopicResponse
  t: Translate
  opportunityHref: string
}) {
  if (answer.outcome === 'converted') {
    return (
      <div className="sortiva-add-topic__answer" data-add-answer="converted">
        <h4>{t('content.add.convertedHeading')}</h4>
        <p>{renderTemplatedLine(answer.warning ?? answer.rejection, t).text}</p>
        {answer.convertedToOpportunityId ? (
          <a href={`${opportunityHref}#${answer.convertedToOpportunityId}`}>
            {t('content.add.convertedLink')}
          </a>
        ) : null}
      </div>
    )
  }

  if (answer.outcome === 'rejected') {
    return (
      <div className="sortiva-add-topic__answer" data-add-answer="rejected">
        <h4>{t('content.add.rejectedHeading')}</h4>
        <p>{renderTemplatedLine(answer.rejection, t).text}</p>
      </div>
    )
  }

  if (answer.outcome === 'planned_with_warning') {
    return (
      <div className="sortiva-add-topic__answer" data-add-answer="planned_with_warning">
        <h4>{t('content.add.warningHeading')}</h4>
        <p>{renderTemplatedLine(answer.warning, t).text}</p>
        {answer.topic ? (
          <p>{t('content.add.planned', { date: formatDate(answer.topic.scheduledFor) })}</p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="sortiva-add-topic__answer" data-add-answer="planned">
      <p>
        {t('content.add.planned', {
          date: formatDate(answer.topic?.scheduledFor ?? ''),
        })}
      </p>
    </div>
  )
}
