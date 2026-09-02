'use client'

import { t as defaultTranslate, type Translate } from '../strings'
import { signalLabel } from '../opportunities/list'
import { topicKindLabel, topicStateLabel } from './calendar'
import type { CalendarTopic } from './types'

/**
 * One topic on one day.
 *
 * The state reads two ways in one word — a coloured dot plus a short label —
 * so it survives greyscale printing and colour-blind viewing, which a colour
 * alone would not. Everything else on the chip is there because a merchant
 * scanning the month needs to tell a refresh from a new article, and needs to
 * see which opportunity a topic came from without opening anything: the small
 * signal tag links back to the card that produced it.
 */

export interface TopicChipProps {
  readonly topic: CalendarTopic
  readonly t?: Translate
  readonly onOpen?: (topic: CalendarTopic) => void
  /** Set while the chip's own request is in flight, so it cannot be fired twice. */
  readonly busy?: boolean
  readonly draggable?: boolean
  readonly onDragStart?: (topic: CalendarTopic) => void
  readonly onDragEnd?: () => void
  readonly opportunityHref?: string
}

export function TopicChip({
  topic,
  t = defaultTranslate,
  onOpen,
  busy = false,
  draggable = false,
  onDragStart,
  onDragEnd,
  opportunityHref = '/opportunities',
}: TopicChipProps) {
  return (
    <div
      className="sortiva-chip"
      data-topic-id={topic.id}
      data-topic-state={topic.state}
      data-topic-kind={topic.kind}
      data-topic-source={topic.source}
      data-topic-pinned={topic.pinned ? 'true' : 'false'}
      data-topic-busy={busy ? 'true' : 'false'}
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', topic.id)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart?.(topic)
      }}
      onDragEnd={() => onDragEnd?.()}
    >
      <button type="button" className="sortiva-chip__open" onClick={() => onOpen?.(topic)}>
        <span className="sortiva-chip__state">
          <span className="sortiva-chip__dot" aria-hidden="true" />
          {topicStateLabel(topic.state, t)}
        </span>
        {topic.kind === 'refresh' ? (
          <span className="sortiva-chip__kind">{topicKindLabel(topic.kind, t)}</span>
        ) : null}
        {topic.pinned ? (
          <span className="sortiva-chip__pin" data-topic-pin="true" aria-hidden="true" />
        ) : null}
        <span className="sortiva-chip__title">{topic.title}</span>
      </button>

      {topic.signalType && topic.opportunityId ? (
        <a
          className="sortiva-chip__signal"
          data-topic-signal={topic.signalType}
          href={`${opportunityHref}#${topic.opportunityId}`}
        >
          {signalLabel(topic.signalType, t)}
        </a>
      ) : null}
    </div>
  )
}
