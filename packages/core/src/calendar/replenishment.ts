import type { OpportunityAction } from '../contracts/opportunities'

/**
 * Topping the calendar back up: which of the opportunities waiting to be
 * written get the empty days, in what order, and what the merchant is told
 * about why each one is there.
 *
 * Everything here is pure — candidates and numbers in, a plan out — so the
 * shares can be held steady while one candidate is varied, and so nothing in
 * this file can reach a database or a model. The two shares this enforces
 * (main §9.6.5's refresh cap and §9.6.6's exploration floor) are the reason
 * the planner does not simply take the top N by score:
 *
 *  - Without the refresh cap a store whose articles all hover near page one
 *    would spend every day revisiting old work and never cover anything new.
 *  - Without the exploration floor the planner only ever repeats what it has
 *    already seen work, and never finds out that some other kind of article
 *    would have worked better. It cannot learn what it never tries.
 *
 * Every threshold arrives as a parameter. None is written here (invariant 9).
 */

/** One axis a pattern can be about, and the value of it this candidate has. */
export interface CandidateDimension {
  readonly dimension: string
  readonly value: string
}

/** An active pattern: this store has enough rated articles on this axis-value for its record to mean something. */
export interface ActivePattern {
  readonly dimension: string
  readonly value: string
  readonly multiplier: number
  /** Whether the articles behind it mostly did well. Only used to decide which sentence the merchant reads. */
  readonly winnerDominant: boolean
}

export interface ReplenishmentCandidate {
  readonly opportunityId: string
  /** CREATE writes something new; REFRESH revisits one of our own articles. Nothing else reaches the calendar. */
  readonly action: Extract<OpportunityAction, 'CREATE' | 'REFRESH'>
  readonly signalType: string
  /**
   * What the opportunity is worth on its own, before anything this planner
   * knows is applied — main §9.6.4's "opportunity" term. Already computed by
   * the engine that detected it, so this planner never re-derives volume or
   * winnability. See DECISIONS 2026-09-03 T4.6.
   */
  readonly baseScore: number
  /** The axes this candidate could match a pattern on. */
  readonly dimensions: readonly CandidateDimension[]
  /** The engine's own reason key, used when nothing this planner did is the more interesting explanation. */
  readonly reasonTemplateKey: string
  readonly reasonParams: Readonly<Record<string, string | number>>
  /** Where a refresh candidate's article currently ranks, when we know. Only ever shown, never scored on. */
  readonly currentPosition: number | null
}

/** Why this candidate scores what it does — the record every why-line is rendered from, so no sentence can outrun the arithmetic. */
export interface ScoringRecord {
  readonly opportunityId: string
  readonly action: ReplenishmentCandidate['action']
  readonly signalType: string
  readonly baseScore: number
  /** The (≤ max) active patterns this candidate matched, before clamping. */
  readonly matchedPatterns: readonly ActivePattern[]
  /** Their product, clamped. 1 when nothing matched. */
  readonly patternMultiplier: number
  readonly sourceBonus: number
  readonly score: number
  /** True when no axis of this candidate has an active pattern — main §9.6.6's "unexplored". */
  readonly unexplored: boolean
  readonly currentPosition: number | null
  readonly reasonTemplateKey: string
  readonly reasonParams: Readonly<Record<string, string | number>>
}

export interface PatternScoringConfig {
  readonly clampMin: number
  readonly clampMax: number
  readonly maxStacked: number
}

/**
 * `score = opportunity × pattern_multipliers × source_bonus` (main §9.6.4).
 *
 * The patterns are looked up at *planning* time rather than taken from the
 * opportunity row, because that is the whole point of the loop: an
 * opportunity detected six weeks ago should be re-ranked by what the store has
 * learned since.
 */
export function scoreCandidate(
  candidate: ReplenishmentCandidate,
  activePatterns: readonly ActivePattern[],
  config: PatternScoringConfig,
  competitorGapSourceBonus: number,
  competitorGapSignalTypes: readonly string[],
): ScoringRecord {
  const matched = candidate.dimensions
    .map((d) => activePatterns.find((p) => p.dimension === d.dimension && p.value === d.value))
    .filter((p): p is ActivePattern => p !== undefined)
    // Highest-impact first, so the cap on how many stack keeps the ones that
    // say the most rather than whichever happened to be listed first.
    .sort((a, b) => Math.abs(b.multiplier - 1) - Math.abs(a.multiplier - 1))
    .slice(0, config.maxStacked)

  const raw = matched.reduce((product, p) => product * p.multiplier, 1)
  const patternMultiplier = Math.min(config.clampMax, Math.max(config.clampMin, raw))
  const sourceBonus = competitorGapSignalTypes.includes(candidate.signalType) ? competitorGapSourceBonus : 1

  return {
    opportunityId: candidate.opportunityId,
    action: candidate.action,
    signalType: candidate.signalType,
    baseScore: candidate.baseScore,
    matchedPatterns: matched,
    patternMultiplier,
    sourceBonus,
    score: candidate.baseScore * patternMultiplier * sourceBonus,
    unexplored: matched.length === 0,
    currentPosition: candidate.currentPosition,
    reasonTemplateKey: candidate.reasonTemplateKey,
    reasonParams: candidate.reasonParams,
  }
}

export interface BatchShares {
  /** Refreshes may fill at most this share of a batch — main §9.6.5. */
  readonly refreshShareMax: number
  /** Whichever of these two is larger is the number of slots kept for unexplored candidates — main §9.6.6. */
  readonly explorationSlotsMin: number
  readonly explorationShareMin: number
}

/** One filled slot: which candidate, and whether it got in on its score or on the exploration reservation. */
export interface BatchPick {
  readonly record: ScoringRecord
  readonly selectedAs: 'score' | 'exploration'
}

export interface BatchPlan {
  readonly picks: readonly BatchPick[]
  readonly candidatesScored: number
  /** How many of the filled slots are refreshes, as a share of the slots offered. */
  readonly refreshShare: number
  readonly explorationShare: number
  /** The cap and floor this batch was planned against, so the event and the logs can say what was in force. */
  readonly refreshCap: number
  readonly explorationReserve: number
}

export function refreshCapFor(slots: number, shares: BatchShares): number {
  return Math.floor(slots * shares.refreshShareMax)
}

export function explorationReserveFor(slots: number, shares: BatchShares): number {
  return Math.min(slots, Math.max(shares.explorationSlotsMin, Math.ceil(slots * shares.explorationShareMin)))
}

/**
 * Which candidates fill the open days.
 *
 * Two passes, in this order and not the other way round. Score first, then
 * *promote* unexplored candidates only if the score pass did not already meet
 * the reservation — rather than handing the reserved slots out before anyone
 * has competed for them.
 *
 * That ordering is what keeps the reservation meaningful in both directions.
 * Until the learning loop runs (main §9.6.3's pattern statistics, which
 * nothing writes yet) *every* candidate is unexplored, so a reserve-first
 * algorithm would label the entire batch "trying something new" and the
 * comparison the label exists for — exploration picks against exploited ones —
 * would have nothing on the other side of it. Promoting only what the score
 * would not have taken means the label is always earned. See DECISIONS
 * 2026-09-03 T4.6.
 */
export function planBatch(
  records: readonly ScoringRecord[],
  slots: number,
  shares: BatchShares,
): BatchPlan {
  const refreshCap = refreshCapFor(slots, shares)
  const explorationReserve = explorationReserveFor(slots, shares)

  // Deterministic: two candidates on the same score must not swap places
  // between two runs of the same batch, or a retry would plan a different
  // calendar.
  const ranked = [...records].sort(
    (a, b) => b.score - a.score || a.opportunityId.localeCompare(b.opportunityId),
  )

  const picks: { record: ScoringRecord; selectedAs: 'score' | 'exploration' }[] = []
  let refreshes = 0
  for (const record of ranked) {
    if (picks.length >= slots) break
    if (record.action === 'REFRESH' && refreshes >= refreshCap) continue
    picks.push({ record, selectedAs: 'score' })
    if (record.action === 'REFRESH') refreshes += 1
  }

  let unexploredPicked = picks.filter((p) => p.record.unexplored).length
  if (unexploredPicked < explorationReserve) {
    const chosen = new Set(picks.map((p) => p.record.opportunityId))
    const promotable = ranked.filter((r) => r.unexplored && !chosen.has(r.opportunityId))

    for (const promote of promotable) {
      if (unexploredPicked >= explorationReserve) break

      // An empty slot needs no victim; only a full batch has to displace
      // something. Either way the refresh cap still binds.
      const wouldBeRefreshes = refreshes + (promote.action === 'REFRESH' ? 1 : 0)
      if (picks.length < slots) {
        if (promote.action === 'REFRESH' && wouldBeRefreshes > refreshCap) continue
        picks.push({ record: promote, selectedAs: 'exploration' })
        if (promote.action === 'REFRESH') refreshes += 1
        unexploredPicked += 1
        continue
      }

      // The lowest-scoring pick that is *not* itself unexplored: displacing
      // another unexplored candidate would not move the count.
      let victimIndex = -1
      for (let i = picks.length - 1; i >= 0; i -= 1) {
        const candidate = picks[i]
        if (candidate && !candidate.record.unexplored) {
          victimIndex = i
          break
        }
      }
      if (victimIndex === -1) break

      const victim = picks[victimIndex]!
      const afterSwap = refreshes - (victim.record.action === 'REFRESH' ? 1 : 0) + (promote.action === 'REFRESH' ? 1 : 0)
      if (afterSwap > refreshCap) continue

      picks[victimIndex] = { record: promote, selectedAs: 'exploration' }
      refreshes = afterSwap
      unexploredPicked += 1
    }
  }

  picks.sort((a, b) => b.record.score - a.record.score || a.record.opportunityId.localeCompare(b.record.opportunityId))

  return {
    picks,
    candidatesScored: records.length,
    refreshShare: slots === 0 ? 0 : refreshes / slots,
    explorationShare: slots === 0 ? 0 : picks.filter((p) => p.selectedAs === 'exploration').length / slots,
    refreshCap,
    explorationReserve,
  }
}

/** A reason the merchant reads: a key into the copy catalogue and the numbers to fill it with. Never a sentence. */
export interface TemplatedWhyLine {
  readonly templateKey: string
  readonly params: Readonly<Record<string, string | number>>
}

export const REPLENISHMENT_WHY_EXPLORATION = 'replenishment.exploration'
export const REPLENISHMENT_WHY_WINNING_PATTERN = 'replenishment.matches_winning_pattern'
export const REPLENISHMENT_WHY_REFRESH_POSITION = 'replenishment.refresh_position'
export const REPLENISHMENT_WHY_COMPETITOR = 'replenishment.competitor_ranks'

/**
 * Main §9.6.8's four sentences, chosen from the scoring record and nothing
 * else — no model is asked why a topic is on the calendar, so the answer is
 * always one the arithmetic can be checked against (invariant 8).
 *
 * The order is deliberate: it goes most-specific-to-this-slot first. A slot
 * that exists *because* of the exploration reservation is explained by that
 * before anything else, because it is the one fact about it the score cannot
 * account for. A candidate matching nothing this planner did keeps the reason
 * the engine that detected it already wrote.
 */
export function whyLineFor(pick: BatchPick): TemplatedWhyLine {
  const record = pick.record

  if (pick.selectedAs === 'exploration') {
    return { templateKey: REPLENISHMENT_WHY_EXPLORATION, params: {} }
  }

  const winning = record.matchedPatterns.find((p) => p.winnerDominant)
  if (winning) {
    return { templateKey: REPLENISHMENT_WHY_WINNING_PATTERN, params: { dimension: winning.dimension } }
  }

  if (record.action === 'REFRESH' && record.currentPosition !== null) {
    return { templateKey: REPLENISHMENT_WHY_REFRESH_POSITION, params: { position: record.currentPosition } }
  }

  if (record.sourceBonus > 1) {
    return { templateKey: REPLENISHMENT_WHY_COMPETITOR, params: {} }
  }

  return { templateKey: record.reasonTemplateKey, params: record.reasonParams }
}

/**
 * How far ahead the calendar is planned, in days: the furthest-out day that
 * still has a topic waiting on it. A calendar with nothing planned ahead has a
 * horizon of zero, which is what makes a brand-new store's first replenishment
 * fire rather than silently do nothing.
 */
export function plannedHorizonDays(furthestPlannedDate: string | null, today: string): number {
  if (!furthestPlannedDate) return 0
  return Math.max(0, daysBetween(today, furthestPlannedDate))
}

export function needsReplenishment(horizonDays: number, triggerHorizonDays: number): boolean {
  return horizonDays < triggerHorizonDays
}

const DAY_MS = 86400000

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00.000Z`)
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00.000Z`)
  return Math.round((b - a) / DAY_MS)
}

/**
 * Every day in `[from, to]` that nothing occupies, in order. A vetoed day is
 * open again — main §8.7 keeps the gap on purpose and says replenishment is
 * what fills it later — and the caller is the one that has already excluded
 * vetoed rows from `occupied`.
 *
 * Pinned and moved topics are, by construction, never touched by any of this:
 * they occupy a day, an occupied day is not offered, and nothing in the
 * replenishment path issues an update to a topic row at all.
 */
export function openDatesInRange(occupied: ReadonlySet<string>, from: string, to: string): readonly string[] {
  const days: string[] = []
  const last = Date.parse(`${to.slice(0, 10)}T00:00:00.000Z`)
  let cursor = Date.parse(`${from.slice(0, 10)}T00:00:00.000Z`)
  while (cursor <= last) {
    const day = new Date(cursor).toISOString().slice(0, 10)
    if (!occupied.has(day)) days.push(day)
    cursor += DAY_MS
  }
  return days
}
