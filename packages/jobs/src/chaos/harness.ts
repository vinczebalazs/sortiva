import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { schema } from '@sortiva/db'
import { seededRandom } from '@sortiva/core'
import { deriveIdempotencyKey } from '../runtime/idempotency'
import { createRun, dispatchableSteps, findStep, getStep } from '../runtime/steps'
import { runStep } from '../runtime/runStep'
// The scenario imports this module back for `WorkerKilled` and the context
// types. The cycle is safe because neither side calls the other while its module
// is still evaluating: this file only lists the scenario in an array, and the
// scenario only uses `WorkerKilled` inside functions.
import { catalogSyncKilledMidWalk } from './catalog-sync.scenario'
import { distillKilledMidBatch } from './distill.scenario'
import { familyGroupKilledAfterCommit } from './family-group.scenario'
import { generationCycleKilledAcrossMidnight, generationCycleKilledSameDay } from './generation-cycle.scenario'
import { signalScanKilledMidPass } from './signal-scan.scenario'

/**
 * Kills workers at random points during a full synthetic ingestion and publish
 * run, then asserts the end state: every step eventually `succeeded`, exactly
 * one remote article per external id, and a billable-call count equal to the
 * number of *distinct* canonical requests.
 *
 * This is what gives the effectively-once guarantees teeth; without it they
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
 * being killed. Because the run is resumable and effectively-once, the
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
  /**
   * How many checkpoints a clean pass of this scenario reaches, if that number
   * is knowable and below the default starting guess of 8. Without this, a
   * scenario with fewer checkpoints than the default risks the first draw
   * overshooting *and* the pass it draws against genuinely finishing the work
   * — which settles the step and records its ledger entry — so every retry
   * after that finds nothing left to interrupt and the scenario reports zero
   * kills despite asking for some. Declaring the true count here makes the
   * very first draw land inside range, so that can never happen. Omit it only
   * when 8 is already a safe underestimate (`catalog_sync`'s six-page walk
   * plus its orders-page boundary, or more).
   */
  readonly initialCeiling?: number
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
  // silently spend the kill budget on kills that never happen. A scenario that
  // knows its own count starts here rather than at the default guess — see
  // `ChaosScenario.initialCeiling`.
  let ceiling = scenario.initialCeiling ?? 8

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
      `${scenario.name}: never completed within ${maxAttempts} attempts. A run that cannot converge is exactly the failure this test exists to catch.`,
    )
  }

  await assertEveryStepSettled(options.pool, options.accountId)
  await scenario.assert({ pool: options.pool, accountId: options.accountId })

  return { scenario: scenario.name, kills, checkpointsReached: reached, restarts: attempt }
}

/**
 * The universal assertion: "every step eventually `succeeded`". `skipped` counts
 * — it is a terminal success for `gsc_connect`, which a merchant may skip — but anything
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
 * The cost assertion: kills must not make us pay twice. Takes the provider
 * double, which counts billable
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
 * A worker that is *killed* mid-step, not one that throws.
 *
 * The distinction is the whole point. An exception unwinds: the executor's
 * `catch` runs, the step lands in `failed_retryable`, and the dispatcher offers
 * it again — which has always worked, and is what the old crash test proved. A
 * killed process leaves the row in `running` with nobody working on it, and
 * before this card nothing ever offered such a row to anyone again: the store's
 * onboarding simply stopped, with no error, no dead-letter entry and no
 * user-visible signal. An ordinary deploy landing during an eight-minute
 * catalogue sync does exactly this (audit T0.4 [blocker]).
 *
 * So this scenario spawns a real child process, lets it commit two page cursors,
 * has it SIGKILL itself, and then asserts the step both *looks* abandoned
 * (`running`, cursor at page 2) and is picked up and finished by the next
 * dispatch — resuming at page 3 rather than re-fetching pages 1 and 2.
 */
const VICTIM = join(dirname(fileURLToPath(import.meta.url)), 'kill-victim.ts')

const TOTAL_PAGES = 5
const KILL_AFTER_PAGE = 2

interface VictimRun {
  pages: number[]
  signal: NodeJS.Signals | null
  code: number | null
}

function runVictimUntilKilled(env: Record<string, string>): Promise<VictimRun> {
  return new Promise((resolve, reject) => {
    // Node directly, with tsx only as a TypeScript loader — the `tsx` CLI would
    // spawn its own child, and we would see that child's exit code rather than
    // the signal that killed it. The victim must be *our* child for the kill to
    // be observable as a kill.
    const child = spawn(process.execPath, ['--import', 'tsx', VICTIM], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      const pages = [...out.matchAll(/^page (\d+)$/gm)].map((m) => Number(m[1]))
      if (code !== 0 && signal === null) {
        reject(new Error(`victim exited ${code} without being killed:\n${err}`))
        return
      }
      resolve({ pages, signal, code })
    })
  })
}

/** Connection string for the database this chaos run is using. */
function connectionStringFor(pool: pg.Pool): string {
  const options = (pool as unknown as { options: { connectionString?: string } }).options
  if (!options.connectionString) throw new Error('the chaos pool has no connection string')
  return options.connectionString
}

interface ProcessDeathState {
  jobId: string
  stepId: string
  key: string
  killedPages: number[]
  resumedPages: number[]
}

const processDeathState: ProcessDeathState = {
  jobId: '',
  stepId: '',
  key: '',
  killedPages: [],
  resumedPages: [],
}

const processDeathMidStep: ChaosScenario = {
  name: 'process_death_mid_step',

  async setup(pool, accountId) {
    const db = drizzle(pool, { schema })
    // One step, so the universal "every step settled" assertion is about this
    // scenario rather than about the eight steps it never runs.
    const { jobId } = await createRun(db, accountId, `chaos-kill-${Date.now()}`, ['detect'])
    const step = await findStep(db, jobId, 'detect')
    processDeathState.jobId = jobId
    processDeathState.stepId = step!.id
    processDeathState.key = deriveIdempotencyKey(accountId, 'detect', 'chaos-v1')
    processDeathState.killedPages = []
    processDeathState.resumedPages = []
  },

  async drive(ctx) {
    const db = drizzle(ctx.pool, { schema })
    const { jobId, stepId, key } = processDeathState

    const victim = await runVictimUntilKilled({
      VICTIM_DATABASE_URL: connectionStringFor(ctx.pool),
      VICTIM_ACCOUNT_ID: ctx.accountId,
      VICTIM_JOB_ID: jobId,
      VICTIM_STEP_ID: stepId,
      VICTIM_IDEMPOTENCY_KEY: key,
      VICTIM_KILL_AFTER_PAGE: String(KILL_AFTER_PAGE),
      VICTIM_TOTAL_PAGES: String(TOTAL_PAGES),
    })
    if (victim.signal !== 'SIGKILL') {
      throw new Error(`the victim was meant to be killed; it exited with code ${victim.code}`)
    }
    processDeathState.killedPages = victim.pages

    // The state the old exception-based test could never produce: owned by a
    // process that no longer exists.
    const stranded = await getStep(db, stepId)
    if (stranded?.state !== 'running') {
      throw new Error(`expected a stranded "running" row, found "${stranded?.state}"`)
    }

    // A lease of 0 ms is "every running row is abandoned" — the test's way of
    // fast-forwarding past the real 15-minute wait in lease.ts.
    const offered = await dispatchableSteps(db, jobId, { leaseMs: 0 })
    if (!offered.some((row) => row.id === stepId)) {
      throw new Error('the dispatcher did not offer the abandoned step: it is stranded forever')
    }

    const resumed = await runStep<{ page: number }>({
      db,
      pool: ctx.pool,
      accountId: ctx.accountId,
      jobId,
      stepId,
      idempotencyKey: key,
      leaseMs: 0,
      handler: async (c) => {
        let page = c.checkpoint?.page ?? 0
        while (page < TOTAL_PAGES) {
          page += 1
          await c.save({ page })
          processDeathState.resumedPages.push(page)
        }
        return { pages: page }
      },
    })
    if (resumed.status !== 'succeeded') {
      throw new Error(`the reclaimed step did not succeed: ${resumed.status}`)
    }
  },

  async assert(ctx) {
    const db = drizzle(ctx.pool, { schema })
    const { killedPages, resumedPages } = processDeathState

    if (killedPages.join(',') !== '1,2') {
      throw new Error(`the victim should have committed pages 1,2 before dying; got ${killedPages}`)
    }
    // A crash resumes from the last committed cursor, not from page one.
    // Re-fetching page 1 would be a re-billed provider call on every deploy.
    if (resumedPages.join(',') !== '3,4,5') {
      throw new Error(`the reclaimed step should resume at page 3; it re-fetched ${resumedPages}`)
    }

    const step = await getStep(db, processDeathState.stepId)
    if (step?.state !== 'succeeded') {
      throw new Error(`the step did not converge: ${step?.state}`)
    }

    // Exactly one completion record for this key, whatever the kills.
    // A killed process must leave none (its work never finished) and the run
    // that finished must leave one; a second row is impossible by primary key,
    // so the number that matters is zero-vs-one. This is the assertion that ties
    // convergence to *not paying twice*: the record is what the next redelivery
    // consults, and it now outlives the job rows entirely.
    const { rows } = await ctx.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM idempotency_ledger WHERE idempotency_key = $1',
      [processDeathState.key],
    )
    if (rows[0]?.n !== 1) {
      throw new Error(`expected exactly one ledger record for the finished work; found ${rows[0]?.n}`)
    }
  },
}

/**
 * Scenarios land with the features that need them. Registering
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
  processDeathMidStep,
  // T2.2's mid-sync crash, which is the case this harness was written expecting:
  // the catalogue sync is the longest thing the product does over a network and
  // so the step most likely to be running when a process ends.
  catalogSyncKilledMidWalk,
  // T2.7: the two steps right after it, each interrupted at the point that
  // actually matters for what they do — mid-catalogue for distillation
  // (paying per product), right after the one write commits for grouping
  // (no per-item cost, but a redelivery must reconcile onto the same rows).
  distillKilledMidBatch,
  familyGroupKilledAfterCommit,
  // T3.7: the signal scan itself, killed between opportunities persisting.
  // No `job_steps` row involved at all — the universal `assertEveryStepSettled`
  // check above passes on this scenario vacuously (no ingestion job exists for
  // this account), and the scenario's own `assert` carries the real
  // convergence proof: no duplicate opportunity rows, and a finished
  // `signal_runs` row whose own counts account for every page.
  signalScanKilledMidPass,
  // T4.6: the day's article, killed while it is being written. Two halves,
  // and the pair is the point: the same kill converges when the retry arrives
  // the same local day, and does not when it arrives the next one. The second
  // is the `T4.5` audit's HIGH finding reproduced rather than described, and
  // it is expected to fail until someone decides what a store's half-written
  // yesterday should become. See DECISIONS 2026-09-03 T4.6.
  generationCycleKilledSameDay,
  generationCycleKilledAcrossMidnight,
]
