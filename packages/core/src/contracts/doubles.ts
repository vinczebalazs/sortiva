import type { EventAttribution, PosthogCapture } from './analytics'
import {
  fixtureCatalogEvents,
  fixtureJudgeVerdict,
  fixtureOpportunities,
  fixtureScheduledTopic,
} from './fixtures'
import type {
  CatalogEvent,
  CatalogEvents,
  ExistingTargetCheck,
  ExistingTargetOutcome,
  JudgeLite,
  JudgeVerdict,
  NotificationEmitter,
  NotificationType,
  Opportunity,
  OpportunitySource,
  QueryCluster,
  ScheduledTopic,
  TopicScheduler,
} from './opportunities'
import { StubImplementation, type StubRegistration } from './stubs'

/**
 * The test doubles for build plan §4's seams. Each behaves exactly as the plan's
 * "stub behaviour until filled" column specifies, registers itself in the stub
 * registry, and emits `stub_used` on every call it serves.
 *
 * A consumer card's done-when may pass against these; the milestone exit gate
 * that follows the producer card re-runs the consumer's tests against the real
 * implementation (build plan §4, closing rule).
 */

function registration(
  contract: string,
  filledBy: string,
  behaviour: string,
  mustBeGoneBy: string,
): StubRegistration {
  return { contract, filledBy, behaviour, mustBeGoneBy }
}

/**
 * Build plan §4: "returns `no_match` and logs `stub_used`".
 *
 * The single most dangerous stub in the repo. main §7.7 makes this check
 * mandatory before any CREATE and invariant 6 forbids a CREATE without it —
 * so while this is wired, every CREATE candidate looks uncontested and the
 * cannibalisation rule is silently off. That is why it registers loudly and
 * why the M3 exit gate fails if it is still here.
 */
export class StubExistingTargetCheck extends StubImplementation implements ExistingTargetCheck {
  constructor(capture?: Pick<PosthogCapture, 'capture'>) {
    super(
      registration(
        'existingTargetCheck',
        'C — T3.5',
        'always returns no_match, so no CREATE is ever converted to OPTIMIZE/REFRESH (main §7.7, invariant 6)',
        'M3',
      ),
      capture,
    )
  }

  async check(cluster: QueryCluster, accountId: string): Promise<ExistingTargetOutcome> {
    this.record('check', { kind: 'account', accountId }, { cluster: cluster.head })
    return { match: 'none' }
  }
}

/** Build plan §4: "fixture pool from `signals.fixtures`". */
export class StubOpportunitySource extends StubImplementation implements OpportunitySource {
  constructor(
    private readonly pool: readonly Opportunity[] = fixtureOpportunities,
    capture?: Pick<PosthogCapture, 'capture'>,
  ) {
    super(
      registration(
        'OpportunitySource',
        'C — T3.6 / T3.7',
        'returns a fixed fixture pool rather than detected opportunities',
        'M3',
      ),
      capture,
    )
  }

  async acceptedContentOpportunities(accountId: string): Promise<readonly Opportunity[]> {
    this.record('acceptedContentOpportunities', { kind: 'account', accountId })
    // main §7.9 — only CREATE and REFRESH are auto-accepted content work.
    return this.pool.filter(
      (o) => o.recommendedAction === 'CREATE' || o.recommendedAction === 'REFRESH',
    )
  }
}

/** Build plan §4: "records intent, no calendar". */
export class StubTopicScheduler extends StubImplementation implements TopicScheduler {
  readonly scheduled: ScheduledTopic[] = []

  constructor(capture?: Pick<PosthogCapture, 'capture'>) {
    super(
      registration(
        'TopicScheduler',
        'D — T4.2',
        'records the intent to schedule; nothing reaches a calendar',
        'M4',
      ),
      capture,
    )
  }

  async schedule(opportunity: Opportunity, date?: string): Promise<ScheduledTopic> {
    this.record('schedule', { kind: 'account', accountId: opportunity.accountId })
    const topic: ScheduledTopic = {
      ...fixtureScheduledTopic,
      topicId: `stub-topic-${this.scheduled.length + 1}`,
      opportunityId: opportunity.id,
      title: opportunity.entityRef.label,
      ...(date ? { scheduledFor: date } : {}),
    }
    this.scheduled.push(topic)
    return topic
  }
}

/**
 * Build plan §4: "passes with fixed scores, logs `stub_used`".
 *
 * A judge that always passes is a quality bar that is switched off (main §8.4,
 * invariant 11). Wired only until T4.4.
 */
export class StubJudgeLite extends StubImplementation implements JudgeLite {
  constructor(
    private readonly verdict: JudgeVerdict = fixtureJudgeVerdict,
    capture?: Pick<PosthogCapture, 'capture'>,
  ) {
    super(
      registration(
        'JudgeLite',
        'D — T4.4',
        'passes everything with fixed scores; the quality bar is not actually applied (main §8.4, invariant 11)',
        'M6',
      ),
      capture,
    )
  }

  async grade(_recommendation: unknown, _pack: unknown): Promise<JudgeVerdict> {
    this.record('grade', { kind: 'account', accountId: 'unknown' })
    return this.verdict
  }
}

/** Build plan §4: "fixture events". */
export class StubCatalogEvents extends StubImplementation implements CatalogEvents {
  constructor(
    private readonly events: readonly CatalogEvent[] = fixtureCatalogEvents,
    capture?: Pick<PosthogCapture, 'capture'>,
  ) {
    super(
      registration('CatalogEvents', 'B — T2.2', 'replays a fixed list of fixture events', 'M2'),
      capture,
    )
  }

  async since(
    accountId: string,
    cursor?: string,
  ): Promise<{ events: readonly CatalogEvent[]; cursor: string }> {
    this.record('since', { kind: 'account', accountId })
    const after = cursor ? this.events.filter((e) => e.occurredAt > cursor) : this.events
    const last = after.at(-1)?.occurredAt ?? cursor ?? ''
    return { events: after, cursor: last }
  }
}

/**
 * Build plan §4: "writes to a test table". In-memory here, because wave 1's
 * `notifications` table already exists and the real emitter (T8.1) writes to it
 * inside the caller's transaction — a second table would be a migration outside
 * a schema wave.
 *
 * It does enforce the constraint that matters: tech §1.2's unique
 * `(account_id, type, dedupe_key)`, so a consumer testing a retried worker sees
 * the second emit no-op exactly as production will.
 */
export class StubNotificationEmitter extends StubImplementation implements NotificationEmitter {
  readonly emitted: {
    type: NotificationType
    refs: Readonly<Record<string, string>>
    dedupeKey: string
    accountId: string
  }[] = []

  private readonly seen = new Set<string>()

  constructor(capture?: Pick<PosthogCapture, 'capture'>) {
    super(
      registration(
        'NotificationEmitter',
        'G — T8.1',
        'records notifications in memory; nothing reaches the bell or an email',
        'M8',
      ),
      capture,
    )
  }

  async emit(
    type: NotificationType,
    refs: Readonly<Record<string, string>>,
    dedupeKey: string,
    attribution: EventAttribution,
  ): Promise<{ created: boolean }> {
    this.record('emit', attribution, { type })
    const accountId = attribution.kind === 'account' ? attribution.accountId : 'preview'
    const key = `${accountId}:${type}:${dedupeKey}`
    if (this.seen.has(key)) return { created: false }
    this.seen.add(key)
    this.emitted.push({ type, refs, dedupeKey, accountId })
    return { created: true }
  }

  of(type: NotificationType) {
    return this.emitted.filter((n) => n.type === type)
  }
}
