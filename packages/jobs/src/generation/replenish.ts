import type pg from 'pg'
import {
  accountAttribution,
  excludeNotInterested,
  localClock,
  needsReplenishment,
  openDatesInRange,
  planBatch,
  plannedHorizonDays,
  scoreCandidate,
  whyLineFor,
  type ActivePattern,
  type EvidenceFact,
  type Logger,
  type Opportunity,
  type OpportunitySource,
  type PosthogCapture,
  type ReplenishmentCandidate,
} from '@sortiva/core'
import {
  accountScope,
  activePatternStats,
  furthestPlannedDate,
  notInterestedFingerprints,
  occupiedDatesInRange,
  readAccountSettings,
  transitionOpportunityStatus,
  type Db,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import { withAccountLock } from '../runtime/lock'
import { runtimeLogger } from '../runtime/logging'
import { DbTopicScheduler, TopicSchedulingError } from './topic-scheduler'

/**
 * Topping one store's calendar back up.
 *
 * The calendar is the execution schedule for everything the product decided is
 * worth writing. It drains a day at a time, and when what is left drops below
 * the configured runway this fills the empty days from the opportunities
 * waiting to be written — ranked by what the store has learned, capped so
 * revisiting old articles cannot crowd out new coverage, and with a floor of
 * slots kept for kinds of article this store has never tried.
 *
 * Three things it deliberately never does:
 *
 *  - **It never touches an existing topic.** Not to move one, not to reorder,
 *    not to unpin. It reads which days are taken and writes only into the ones
 *    that are not, so a pinned topic and a topic the merchant dragged
 *    somewhere are untouched by construction rather than by a check that could
 *    be forgotten.
 *  - **It never fills a day that has already passed.** A day that went by
 *    without an article stays gone; the calendar's gaps are not owed back as a
 *    burst later.
 *  - **It never re-proposes something the merchant deleted.** Vetoed subjects
 *    are held on a list this consults before scoring anything.
 */

/** Main §9.6.9's event. Counts and shares only — never a title, never a keyword. */
export const REPLENISHMENT_COMPLETED_EVENT = 'replenishment_completed'

export interface ReplenishDeps {
  readonly db: Db
  /** The per-account lock needs a connection of its own, outside the pool the work runs on. */
  readonly pool: pg.Pool
  readonly opportunities: OpportunitySource
  readonly capture?: Pick<PosthogCapture, 'capture'>
  readonly now?: () => Date
  readonly logger?: Logger
}

export type ReplenishOutcome =
  /** The calendar is planned far enough ahead already, or has no open day, or nothing is waiting to be written. */
  | { readonly status: 'not_due' | 'no_open_days' | 'no_candidates'; readonly horizonDays: number }
  | {
      readonly status: 'filled'
      readonly horizonDays: number
      readonly candidatesScored: number
      readonly slotsFilled: number
      readonly refreshShare: number
      readonly explorationShare: number
    }

/**
 * Which axes a candidate could match a learned pattern on. Read off the
 * opportunity's own evidence, which is where the engine that detected it
 * already records them — main §9.6.3's three content dimensions, plus the
 * action type §9.6.10 adds.
 */
function dimensionsFor(opportunity: Opportunity): { dimension: string; value: string }[] {
  const dimensions: { dimension: string; value: string }[] = [
    { dimension: 'action_type', value: opportunity.recommendedAction.toLowerCase() },
  ]
  for (const fact of opportunity.evidence) {
    if (fact.key === 'intent_class' && typeof fact.value === 'string') {
      dimensions.push({ dimension: 'intent_class', value: fact.value })
    }
    if (fact.key === 'family_id' && typeof fact.value === 'string') {
      dimensions.push({ dimension: 'family_id', value: fact.value })
    }
  }
  if (opportunity.entityRef.kind === 'query_cluster') {
    dimensions.push({ dimension: 'keyword_cluster', value: opportunity.entityRef.id })
  }
  return dimensions
}

function numericFact(evidence: readonly EvidenceFact[], key: string): number | null {
  const fact = evidence.find((f) => f.key === key)
  if (!fact) return null
  const value = typeof fact.value === 'number' ? fact.value : Number(fact.value)
  return Number.isFinite(value) ? value : null
}

/** The search term a vetoed-subject fingerprint is taken over — the same string the calendar shows as the topic's title. */
function searchTermFor(opportunity: Opportunity): string {
  return opportunity.entityRef.kind === 'query_cluster' ? opportunity.entityRef.id : opportunity.entityRef.label
}

function toCandidate(opportunity: Opportunity): ReplenishmentCandidate | null {
  if (opportunity.recommendedAction !== 'CREATE' && opportunity.recommendedAction !== 'REFRESH') return null
  return {
    opportunityId: opportunity.id,
    action: opportunity.recommendedAction,
    signalType: opportunity.signalType,
    baseScore: opportunity.impactScore,
    dimensions: dimensionsFor(opportunity),
    reasonTemplateKey: opportunity.reasonTemplateKey,
    reasonParams: opportunity.reasonParams,
    currentPosition: numericFact(opportunity.evidence, 'mean_position') ?? numericFact(opportunity.evidence, 'our_position'),
  }
}

/** The signals whose whole reason to exist is that somebody else already ranks — main §9.6.4's source bonus. */
const COMPETITOR_GAP_SIGNALS = ['competitor_coverage_gap']

export async function replenishCalendarForAccount(
  deps: ReplenishDeps,
  accountId: string,
): Promise<ReplenishOutcome> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(accountId)
  const config = rules().defaults

  const outcome = await withAccountLock(deps.pool, accountId, async (): Promise<ReplenishOutcome> => {
    const settings = await readAccountSettings(deps.db, scope)
    const today = localClock(now, settings.timezone).date

    const furthest = await furthestPlannedDate(deps.db, scope, today)
    const horizonDays = plannedHorizonDays(furthest, today)
    if (!needsReplenishment(horizonDays, config.learning.replenishment_horizon_days)) {
      log.info('replenishment_not_due', { account_id: accountId, horizon_days: horizonDays })
      return { status: 'not_due', horizonDays }
    }

    // Tomorrow at the earliest: today's dequeue may already have run, and a
    // topic placed on a day whose cycle has passed would never be written.
    const from = addDaysIso(today, 1)
    const to = addDaysIso(today, config.learning.replenishment_target_horizon_days)
    const occupied = await occupiedDatesInRange(deps.db, scope, from, to)
    const openDays = openDatesInRange(occupied, from, to)
    if (openDays.length === 0) {
      log.info('replenishment_no_open_days', { account_id: accountId, horizon_days: horizonDays })
      return { status: 'no_open_days', horizonDays }
    }

    const accepted = await deps.opportunities.acceptedContentOpportunities(accountId)
    const vetoed = await notInterestedFingerprints(deps.db, scope)
    const candidates = excludeNotInterested(
      accepted
        .map((opportunity) => ({ opportunity, candidate: toCandidate(opportunity) }))
        .filter((pair): pair is { opportunity: Opportunity; candidate: ReplenishmentCandidate } => pair.candidate !== null)
        .map((pair) => ({ ...pair, searchTerm: searchTermFor(pair.opportunity) })),
      vetoed,
    )

    if (candidates.length === 0) {
      log.info('replenishment_no_candidates', { account_id: accountId, horizon_days: horizonDays })
      return { status: 'no_candidates', horizonDays }
    }

    const patterns = await readActivePatterns(deps.db, scope, config)
    const records = candidates.map((c) =>
      scoreCandidate(
        c.candidate,
        patterns,
        {
          clampMin: config.learning.patterns.multiplier_clamp_min,
          clampMax: config.learning.patterns.multiplier_clamp_max,
          maxStacked: config.learning.patterns.max_stacked_multipliers,
        },
        config.scoring.create.competitor_gap_source_bonus,
        COMPETITOR_GAP_SIGNALS,
      ),
    )

    const plan = planBatch(records, openDays.length, {
      refreshShareMax: config.learning.refresh.batch_share_max,
      explorationSlotsMin: config.learning.exploration.reserved_slots_min,
      explorationShareMin: config.learning.exploration.reserved_share_min,
    })

    const byId = new Map(candidates.map((c) => [c.opportunity.id, c.opportunity]))
    const scheduler = new DbTopicScheduler({ db: deps.db, now: () => now })

    let filled = 0
    let refreshes = 0
    let explorations = 0
    // Days are handed out only to placements that actually happen, so a
    // candidate that turns out to be unplaceable leaves its day for the next
    // pick rather than punching a hole in the calendar.
    let dayCursor = 0
    for (const pick of plan.picks) {
      const opportunity = byId.get(pick.record.opportunityId)
      const day = openDays[dayCursor]
      if (!opportunity || !day) continue

      // Claim the opportunity *before* writing the topic, not after.
      //
      // The order is the whole of the no-duplicate guarantee. Place-then-claim
      // means a run that dies between the two comes back, sees the
      // opportunity still waiting, and gives it a second calendar day — two
      // articles on one subject, which is exactly what the calendar is
      // supposed to prevent. Claim-first can only fail the other way: a crash
      // leaves an opportunity marked scheduled with no topic, which costs one
      // candidate and no merchant-visible damage. Guarded, so two passes
      // racing produce one placement between them and the loser moves on.
      const claimed = await transitionOpportunityStatus(
        deps.db,
        scope,
        opportunity.id,
        { from: ['accepted'], to: 'scheduled' },
        now,
      )
      if (!claimed) {
        log.info('replenishment_opportunity_already_taken', {
          account_id: accountId,
          opportunity_id: opportunity.id,
        })
        continue
      }

      const why = whyLineFor(pick)
      try {
        await scheduler.schedule(opportunity, day, {
          source: pick.selectedAs === 'exploration' ? 'exploration' : 'auto',
          whyLineKey: why.templateKey,
          score: pick.record.score,
        })
      } catch (error) {
        if (error instanceof TopicSchedulingError) {
          // Degrade to pause, never guess: an opportunity that cannot say
          // which article template it needs goes back in the pool for the next
          // pass rather than onto a guessed one.
          await transitionOpportunityStatus(
            deps.db,
            scope,
            opportunity.id,
            { from: ['scheduled'], to: 'accepted' },
            now,
          )
          log.warn('replenishment_schedule_failed', {
            account_id: accountId,
            opportunity_id: opportunity.id,
            signal_type: opportunity.signalType,
            error: error.message,
          })
          continue
        }
        throw error
      }

      dayCursor += 1
      filled += 1
      if (pick.record.action === 'REFRESH') refreshes += 1
      if (pick.selectedAs === 'exploration') explorations += 1
    }

    log.info('replenishment_complete', {
      account_id: accountId,
      horizon_days: horizonDays,
      candidates_scored: plan.candidatesScored,
      slots_offered: openDays.length,
      slots_filled: filled,
      refresh_cap: plan.refreshCap,
      exploration_reserve: plan.explorationReserve,
    })

    return {
      status: 'filled',
      horizonDays,
      candidatesScored: plan.candidatesScored,
      slotsFilled: filled,
      refreshShare: filled === 0 ? 0 : refreshes / filled,
      explorationShare: filled === 0 ? 0 : explorations / filled,
    }
  })

  if (outcome.status === 'filled') {
    deps.capture?.capture({
      event: REPLENISHMENT_COMPLETED_EVENT,
      attribution: accountAttribution(accountId),
      properties: {
        candidates_scored: outcome.candidatesScored,
        slots_filled: outcome.slotsFilled,
        refresh_share: round2(outcome.refreshShare),
        exploration_share: round2(outcome.explorationShare),
      },
    })
  }

  return outcome
}

/**
 * The store's active patterns, turned into the multipliers §9.6.3 defines.
 *
 * The stored multiplier is what a row already carries; the winner-dominant
 * flag is recomputed here from the counts, because it decides only which
 * sentence the merchant reads and must therefore agree with the numbers rather
 * than with whatever wrote the row.
 */
async function readActivePatterns(
  db: Db,
  scope: ReturnType<typeof accountScope>,
  config: ReturnType<typeof rules>['defaults'],
): Promise<ActivePattern[]> {
  const rows = await activePatternStats(db, scope, config.learning.patterns.activation_min_rated)
  return rows.map((row) => ({
    dimension: row.dimension,
    value: row.dimensionValue,
    multiplier: Number(row.multiplier),
    winnerDominant: row.ratedN > 0 && row.winnerN / row.ratedN >= config.learning.patterns.dominance_share_min,
  }))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

const DAY_MS = 86400000

function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10)
}
