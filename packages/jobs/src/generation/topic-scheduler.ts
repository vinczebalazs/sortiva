import {
  earliestSchedulableDate,
  pickOpenDate,
  toIsoDate,
  INTENT_CLASSES,
  type EvidenceFact,
  type IntentClass,
  type Opportunity,
  type ScheduledTopic,
  type TopicScheduler,
} from '@sortiva/core'
import { accountScope, insertTopic, occupiedDatesInRange, setOpportunityTopicId, type Db } from '@sortiva/db'

/**
 * The real `TopicScheduler` (main §8.7 / build plan §4's frozen contract row,
 * "records the intent to schedule; nothing reaches a calendar" until this
 * card fills it): given an already-accepted CREATE/REFRESH opportunity, where
 * on the calendar it lands.
 *
 * Deliberately does **not** run Gate 1. The interface's own doc comment
 * ("picks the next open calendar day by default ... a pinned occupant is
 * never displaced") describes placement only, and Gate 1 needs inputs
 * (measured search volume, substance inventory, the existing-target check)
 * this call is not given — running admission is the job of whoever calls
 * `schedule()` with an opportunity that has not been gate-checked yet
 * (`T4.6`'s replenishment scoring, per the build plan's own sequencing: T4.6
 * done-when is "opportunity → topic → **gates** → article", naming gates as
 * a step after this one, not inside it).
 */

const DEFAULT_HORIZON_DAYS = 120

export class TopicSchedulingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TopicSchedulingError'
  }
}

export interface DbTopicSchedulerDeps {
  readonly db: Db
  readonly now?: () => Date
  readonly horizonDays?: number
}

export class DbTopicScheduler implements TopicScheduler {
  constructor(private readonly deps: DbTopicSchedulerDeps) {}

  async schedule(opportunity: Opportunity, date?: string): Promise<ScheduledTopic> {
    if (opportunity.recommendedAction !== 'CREATE' && opportunity.recommendedAction !== 'REFRESH') {
      throw new TopicSchedulingError(
        `TopicScheduler only places CREATE/REFRESH opportunities on the calendar; ` +
          `opportunity ${opportunity.id} is recommended as ${opportunity.recommendedAction}.`,
      )
    }

    // The `Opportunity` contract (frozen in M0, `packages/core/src/contracts/opportunities.ts`)
    // carries no `intentClass` field, and `EvidenceFact.value` is `string |
    // number`, so it has no channel for `familyIds` (an array) either. This
    // function reads `intentClass` from an `intent_class` evidence fact —
    // the convention Gate 1's own evidence-building already uses
    // (`packages/core/src/gates/gate1.ts`'s `buildEvidence`) — because it is
    // the one convention already established in this codebase, not because
    // the wire format is agreed with Lane C's still-unbuilt Opportunity
    // Engine. Failing loudly when it is absent, rather than defaulting to a
    // guessed intent class, is main §14.4's "degrade to pause, never to
    // lower quality" applied to this seam. `familyIds` has no such fallback
    // available at all, so it defaults to `[]` — schema-legal
    // (`topics.family_ids` has a `NOT NULL DEFAULT '{}'`) though incomplete.
    // Both are flagged, not silently guessed — see DECISIONS 2026-09-03 T4.2.
    const intentClass = intentClassFromEvidence(opportunity.evidence)
    if (!intentClass) {
      throw new TopicSchedulingError(
        `Opportunity ${opportunity.id} carries no usable "intent_class" evidence fact; ` +
          `TopicScheduler has no other way to know which article template this topic needs. ` +
          `See DECISIONS 2026-09-03 T4.2.`,
      )
    }
    const familyIds: readonly string[] = []

    const now = (this.deps.now ?? (() => new Date()))()
    const scope = accountScope(opportunity.accountId)
    const today = toIsoDate(now)
    const earliest = earliestSchedulableDate(today)
    const preferred = date && date > earliest ? date : earliest
    const horizonDays = this.deps.horizonDays ?? DEFAULT_HORIZON_DAYS

    const occupied = await occupiedDatesInRange(this.deps.db, scope, preferred, addDaysIso(preferred, horizonDays))
    const scheduledFor = pickOpenDate(occupied, preferred, horizonDays)

    const title = opportunity.entityRef.label
    const targetKeyword = opportunity.entityRef.kind === 'query_cluster' ? opportunity.entityRef.id : null

    const topic = await insertTopic(
      this.deps.db,
      scope,
      {
        opportunityId: opportunity.id,
        title,
        targetKeyword,
        keywordCluster: null,
        intentClass,
        familyIds,
        kind: opportunity.recommendedAction === 'REFRESH' ? 'refresh' : 'new',
        source: 'auto',
        whyLine: opportunity.reasonTemplateKey,
        scheduledDate: scheduledFor,
        pinned: false,
        state: 'planned',
      },
      now,
    )

    await setOpportunityTopicId(this.deps.db, scope, opportunity.id, topic.id, now)

    return {
      topicId: topic.id,
      opportunityId: opportunity.id,
      scheduledFor: topic.scheduledDate,
      title: topic.title,
      state: 'planned',
    }
  }
}

function intentClassFromEvidence(evidence: readonly EvidenceFact[]): IntentClass | null {
  const fact = evidence.find((f) => f.key === 'intent_class')
  if (!fact || typeof fact.value !== 'string') return null
  return (INTENT_CLASSES as readonly string[]).includes(fact.value) ? (fact.value as IntentClass) : null
}

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
