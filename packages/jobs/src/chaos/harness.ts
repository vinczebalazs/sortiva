import type pg from 'pg'
import { seededRandom } from '@sortiva/core'

/**
 * main §14.3.9 — "a chaos test in CI kills workers at random points during a
 * full synthetic ingestion + publish run and asserts the end state: every step
 * eventually `succeeded`, exactly one remote article per `article_external_id`,
 * DataForSEO billable-call count equals the number of *distinct* canonical
 * requests. This test is the specification's teeth; without it, the guarantees
 * above rot silently."
 *
 * The harness owns the killing and the convergence assertions; the scenarios own
 * what is being run, and land with the features (T2.2's mid-sync crash, T5.1's
 * kill between publish steps 2 and 3). M0 ships the machinery and one empty
 * scenario, so `pnpm chaos` is green and real cases only have to be added.
 *
 * How a kill works: the scenario's driver calls `ctx.checkpoint(label)` at every
 * point a worker could realistically die — after a page write, between publish
 * intent and execute. The harness picks one of those points with a seeded PRNG
 * and throws `WorkerKilled` there, then re-runs the driver from the top, which
 * is what a restarted worker does. That repeats until a pass completes without
 * being killed. Because the run is resumable and effectively-once (§14.3), the
 * end state must be identical to a run that was never interrupted — and that is
 * the whole assertion.
 */

export class WorkerKilled extends Error {
  constructor(readonly at: string) {
    super(`worker killed at "${at}"`)
    this.name = 'WorkerKilled'
  }
}

export interface ChaosContext {
  readonly pool: pg.Pool
  readonly accountId: string
  /** Which restart this is: 0 on the first attempt. */
  readonly attempt: number
  /**
   * A point at which a worker could die. Throws `WorkerKilled` when the harness
   * has chosen this one; returns otherwise.
   */
  checkpoint(label: string): void
}

export interface ChaosScenario {
  readonly name: string
  /** Runs once before the first attempt: seeds the database. */
  setup?(pool: pg.Pool, accountId: string): Promise<void>
  /** The work under test. Re-run from the top after every kill. */
  drive(ctx: ChaosContext): Promise<void>
  /**
   * Scenario-specific convergence assertions, on top of the universal ones.
   * Throw to fail.
   */
  assert(ctx: Omit<ChaosContext, 'checkpoint' | 'attempt'>): Promise<void>
}

export interface ChaosResult {
  readonly scenario: string
  /** How many times the driver was killed before a pass completed. */
  readonly kills: number
  /** Every checkpoint label the driver reached, in order, on the surviving pass. */
  readonly checkpointsReached: readonly string[]
  /** How many times the driver was re-run: one per kill, plus any overshooting draw. */
  readonly restarts: number
}

export interface ChaosOptions {
  pool: pg.Pool
  accountId: string
  /** Same seed, same kill points — a failing chaos run must be reproducible. */
  seed?: number
  /** How many kills to inject before letting a pass through. */
  kills?: number
  /** Guard against a scenario that never completes. */
  maxAttempts?: number
}

export async function runChaosScenario(
  scenario: ChaosScenario,
  options: ChaosOptions,
): Promise<ChaosResult> {
  const random = seededRandom(options.seed ?? 1)
  const killBudget = options.kills ?? 3
  const maxAttempts = options.maxAttempts ?? killBudget + 5

  await scenario.setup?.(options.pool, options.accountId)

  let kills = 0
  let attempt = 0
  let reached: string[] = []
  // How many checkpoints a pass is assumed to have. Tightened to the real count
  // the first time a pass runs to completion, so an overshooting draw cannot
  // silently spend the kill budget on kills that never happen.
  let ceiling = 8

  while (attempt < maxAttempts) {
    const seen: string[] = []
    // The kill point is drawn before the pass starts, so the choice cannot
    // depend on how far this particular pass happens to get.
    const killAfter =
      kills < killBudget ? 1 + Math.floor(random() * ceiling) : Number.POSITIVE_INFINITY

    const ctx: ChaosContext = {
      pool: options.pool,
      accountId: options.accountId,
      attempt,
      checkpoint(label: string) {
        seen.push(label)
        if (seen.length === killAfter) throw new WorkerKilled(label)
      },
    }

    try {
      await scenario.drive(ctx)
    } catch (error) {
      if (!(error instanceof WorkerKilled)) throw error
      kills += 1
      attempt += 1
      continue
    }

    // The pass survived. If the budget is unspent, the draw overshot the run's
    // length — tighten the ceiling to what the run actually offers and try
    // again, rather than reporting a chaos run that was never interrupted.
    if (kills < killBudget && seen.length > 0) {
      ceiling = seen.length
      attempt += 1
      continue
    }

    reached = seen
    break
  }

  if (attempt >= maxAttempts) {
    throw new Error(
      `${scenario.name}: never completed within ${maxAttempts} attempts. A run that cannot converge is the failure §14.3.9 exists to catch.`,
    )
  }

  await assertEveryStepSettled(options.pool, options.accountId)
  await scenario.assert({ pool: options.pool, accountId: options.accountId })

  return { scenario: scenario.name, kills, checkpointsReached: reached, restarts: attempt }
}

/**
 * The universal assertion: "every step eventually `succeeded`". `skipped` counts
 * — main §14.3.1 makes it a terminal success for `gsc_connect` — but anything
 * still `pending`, `running` or failed means the run did not converge.
 */
export async function assertEveryStepSettled(pool: pg.Pool, accountId: string): Promise<void> {
  const { rows } = await pool.query<{ step: string; state: string }>(
    `SELECT s.step, s.state
       FROM job_steps s
       JOIN ingestion_jobs j ON j.id = s.job_id
      WHERE j.account_id = $1
        AND s.state <> 'succeeded'
        AND s.state <> 'skipped'`,
    [accountId],
  )
  if (rows.length > 0) {
    throw new Error(
      `steps did not converge: ${rows.map((r) => `${r.step}=${r.state}`).join(', ')}`,
    )
  }
}

/**
 * §14.3.9's cost assertion. Takes the provider double, which counts billable
 * calls and distinct canonical requests by the same key the live adapter uses.
 */
export function assertNoDoubleBilling(provider: {
  billableCalls: number
  calls: readonly { cacheHit: boolean }[]
}): void {
  const distinct = provider.calls.filter((c) => !c.cacheHit).length
  if (provider.billableCalls !== distinct) {
    throw new Error(
      `billable calls (${provider.billableCalls}) does not equal distinct canonical requests (${distinct}) — a retry re-billed`,
    )
  }
}

/**
 * Scenarios land with the features that need them (main §14.3.9). Registering
 * them here rather than letting each card add a bespoke test keeps the
 * convergence assertions in one place.
 */
export const CHAOS_SCENARIOS: readonly ChaosScenario[] = [
  {
    name: 'empty',
    // The harness itself under test: no work, no kills possible, converges
    // trivially. Real cases replace nothing — they are added alongside it.
    async drive() {},
    async assert() {},
  },
]
