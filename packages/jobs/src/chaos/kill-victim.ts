import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { schema } from '@sortiva/db'
import { runStep } from '../runtime/runStep'

/**
 * The victim half of the `process_death_mid_step` chaos scenario. Run as a real
 * child process by `harness.ts`, and killed by itself with SIGKILL partway
 * through a step.
 *
 * Why a separate process at all: the existing crash test simulates a crash by
 * *throwing*, which unwinds normally and leaves the step in `failed_retryable` —
 * a state that has always resumed correctly. The failure that actually happens
 * in production is different in kind: the process stops between two statements,
 * nothing unwinds, no `catch` and no `finally` runs, and the row is left in
 * `running` with nobody working on it. Only a real signal produces that, so this
 * process really is killed.
 *
 * Reads its whole job from the environment and writes a line per committed page
 * to stdout, so the parent can assert which pages were fetched.
 */

const {
  VICTIM_DATABASE_URL,
  VICTIM_ACCOUNT_ID,
  VICTIM_JOB_ID,
  VICTIM_STEP_ID,
  VICTIM_IDEMPOTENCY_KEY,
  VICTIM_KILL_AFTER_PAGE,
  VICTIM_TOTAL_PAGES,
} = process.env

if (!VICTIM_DATABASE_URL || !VICTIM_STEP_ID) {
  throw new Error('kill-victim requires VICTIM_DATABASE_URL and VICTIM_STEP_ID')
}

const killAfter = Number(VICTIM_KILL_AFTER_PAGE ?? 0)
const totalPages = Number(VICTIM_TOTAL_PAGES ?? 5)

const pool = new pg.Pool({ connectionString: VICTIM_DATABASE_URL, max: 4 })
const db = drizzle(pool, { schema })

const outcome = await runStep<{ page: number }>({
  db,
  pool,
  accountId: VICTIM_ACCOUNT_ID!,
  jobId: VICTIM_JOB_ID!,
  stepId: VICTIM_STEP_ID,
  idempotencyKey: VICTIM_IDEMPOTENCY_KEY!,
  handler: async (ctx) => {
    let page = ctx.checkpoint?.page ?? 0
    while (page < totalPages) {
      page += 1
      // The cursor is committed page by page, so a crash resumes here.
      await ctx.save({ page })
      process.stdout.write(`page ${page}\n`)
      if (page === killAfter) {
        // Not an exception: the process stops here. No unwinding, no cleanup,
        // no state transition — exactly what a Railway deploy does to a worker
        // once the grace period runs out.
        process.kill(process.pid, 'SIGKILL')
        // Unreachable in practice; keeps the loop from racing ahead if the
        // signal is delivered a tick late.
        await new Promise(() => {})
      }
    }
    return { pages: page }
  },
})

process.stdout.write(`outcome ${outcome.status}\n`)
await pool.end()
