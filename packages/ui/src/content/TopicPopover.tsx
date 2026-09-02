'use client'

import { t as defaultTranslate, type Translate } from '../strings'
import { signalLabel } from '../opportunities/list'
import { renderTemplatedLine } from '../opportunities/why'
import { intentLabel, topicSourceLabel, topicStateLabel, vetoKind } from './calendar'
import { RejectionCard } from './RejectionCard'
import type { CalendarTopic } from './types'

/**
 * Everything about one topic, and the things a merchant may do to it.
 *
 * The action row is the whole point of the calendar's posture: the plan runs by
 * itself, and the merchant can change their mind about any of it right up to
 * the moment the day's job takes the topic. After that the veto stops being a
 * removal and becomes a decision not to publish something already written, so
 * it reads differently and asks for confirmation — the one hard edge in the
 * screen, stated rather than hidden.
 *
 * A held day carries its reason card here rather than a link to one: the reason
 * something did not publish is the thing the merchant came to find out.
 */

export interface TopicPopoverProps {
  readonly topic: CalendarTopic
  readonly t?: Translate
  readonly busy?: boolean
  readonly opportunityHref?: string
  readonly articleHref?: (articleId: string) => string
  readonly onClose: () => void
  readonly onVeto: (topic: CalendarTopic) => void
  readonly onPin: (topic: CalendarTopic, pinned: boolean) => void
}

export function TopicPopover({
  topic,
  t = defaultTranslate,
  busy = false,
  opportunityHref = '/opportunities',
  articleHref = (id) => `/content/articles/${id}`,
  onClose,
  onVeto,
  onPin,
}: TopicPopoverProps) {
  const veto = vetoKind(topic)
  const why = renderTemplatedLine(topic.why, t)

  return (
    <div
      className="sortiva-topic-popover"
      role="dialog"
      aria-label={t('content.popover.label')}
      data-topic-popover={topic.id}
      data-topic-state={topic.state}
    >
      <div className="sortiva-topic-popover__head">
        <h3 className="sortiva-topic-popover__title">{topic.title}</h3>
        <button type="button" className="sortiva-topic-popover__close" onClick={onClose}>
          {t('content.popover.close')}
        </button>
      </div>

      <dl className="sortiva-topic-popover__facts">
        <dt>{t('content.popover.state')}</dt>
        <dd data-fact="state">{topicStateLabel(topic.state, t)}</dd>

        {topic.targetKeyword ? (
          <>
            <dt>{t('content.popover.keyword')}</dt>
            <dd data-fact="keyword">
              {topic.targetKeyword}
              <span className="sortiva-topic-popover__volume">
                {topic.monthlySearchVolume === null
                  ? t('content.popover.volumeUnknown')
                  : t('content.popover.volume', { volume: topic.monthlySearchVolume })}
              </span>
            </dd>
          </>
        ) : null}

        <dt>{t('content.popover.intent')}</dt>
        <dd data-fact="intent">{intentLabel(topic.intentClass, t)}</dd>

        <dt>{t('content.popover.from')}</dt>
        <dd data-fact="source">
          {topic.signalType ? signalLabel(topic.signalType, t) : topicSourceLabel(topic.source, t)}
        </dd>

        <dt>{t('content.popover.why')}</dt>
        <dd data-fact="why" data-why-known={why.known ? 'true' : 'false'}>
          {why.text}
        </dd>
      </dl>

      {topic.rejection ? (
        <RejectionCard
          gate={topic.rejection.gate}
          reason={topic.rejection.reason}
          date={topic.scheduledFor}
          draftHref={topic.articleId ? articleHref(topic.articleId) : null}
          t={t}
        />
      ) : null}

      <div className="sortiva-topic-popover__links">
        {topic.opportunityId ? (
          <a href={`${opportunityHref}#${topic.opportunityId}`} data-popover-link="opportunity">
            {t('content.popover.opportunity')}
          </a>
        ) : null}
        {topic.articleId ? (
          <a href={articleHref(topic.articleId)} data-popover-link="article">
            {t('content.popover.openArticle')}
          </a>
        ) : null}
      </div>

      {veto === 'unavailable' ? null : (
        <div className="sortiva-topic-popover__actions">
          <button
            type="button"
            className="sortiva-topic-popover__veto"
            data-popover-action="veto"
            data-veto-kind={veto}
            disabled={busy}
            onClick={() => onVeto(topic)}
          >
            {veto === 'cancel_publication'
              ? t('content.popover.cancelPublication')
              : t('content.popover.veto')}
          </button>
          <button
            type="button"
            className="sortiva-topic-popover__pin"
            data-popover-action="pin"
            disabled={busy}
            onClick={() => onPin(topic, !topic.pinned)}
          >
            {topic.pinned ? t('content.popover.unpin') : t('content.popover.pin')}
          </button>
        </div>
      )}

      {veto === 'remove' && !topic.pinned ? (
        <p className="sortiva-topic-popover__hint">{t('content.popover.dragHint')}</p>
      ) : null}
    </div>
  )
}
