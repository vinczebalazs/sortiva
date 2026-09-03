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

/**
 * What the planner knows about a placement that the opportunity alone does
 * not: the score it was ranked on, whether it got the day because the score
 * chose it or because the exploration reservation did, and the key of the
 * sentence the merchant will read.
 *
 * All three are optional, because the seam's other caller — the onboarding
 * seed — has none of them: an unscored placement keeps the opportunity's own
 * reason and counts as ordinary automatic work.
 *
 * Deliberately beyond the frozen `TopicScheduler` interface. Extra optional
 * parameters still satisfy it, so the contract stays exactly as M0 froze it
 * while the one real implementation can carry more, and there is still only
 * one piece of code that inserts a calendar topic. See DECISIONS 2026-09-03
 * T4.6.
 */
export interface TopicPlacement {
  readonly source?: 'auto' | 'exploration'
  readonly whyLineKey?: string
  readonly score?: number
}

export class DbTopicScheduler implements TopicScheduler {
  constructor(private readonly deps: DbTopicSchedulerDeps) {}

  async schedule(opportunity: Opportunity, date?: string, placement?: TopicPlacement): Promise<ScheduledTopic> {
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
    // lower quality" applied to this seam.
    //
    // `familyIds` uses the other half of the same convention: because a fact's
    // value cannot be an array, the families an opportunity is backed by are
    // written as one repeated `family_id` fact each. Every new-coverage signal
    // already emits them that way; this reads them back. An opportunity
    // carrying none still schedules — a topic with no mapped families is a
    // legitimate thing for the pipeline's own substance gate to hold and say
    // so about, which is a visible refusal rather than a silent wrong answer.
    // See DECISIONS 2026-09-03 T4.2, T3.7 and T4.6.
    const intentClass = intentClassFromEvidence(opportunity.evidence)
    if (!intentClass) {
      throw new TopicSchedulingError(
        `Opportunity ${opportunity.id} carries no usable "intent_class" evidence fact; ` +
          `TopicScheduler has no other way to know which article template this topic needs. ` +
          `See DECISIONS 2026-09-03 T4.2.`,
      )
    }
    const familyIds = familyIdsFromEvidence(opportunity.evidence)

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
        source: placement?.source ?? 'auto',
        whyLine: placement?.whyLineKey ?? opportunity.reasonTemplateKey,
        ...(placement?.score !== undefined ? { score: placement.score } : {}),
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

/**
 * `topics.family_ids` is a uuid array, so anything that is not one would be
 * rejected by Postgres rather than merely be wrong. Filtering here means a
 * malformed fact costs that family rather than the whole placement.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function familyIdsFromEvidence(evidence: readonly EvidenceFact[]): readonly string[] {
  const ids = evidence
    .filter((fact) => fact.key === 'family_id' && typeof fact.value === 'string')
    .map((fact) => String(fact.value))
    .filter((id) => UUID.test(id))
  return [...new Set(ids)]
}

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
