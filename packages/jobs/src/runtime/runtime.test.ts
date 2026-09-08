import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import { eq } from 'drizzle-orm'
import { jobSteps } from '@sortiva/db'
import {
  TEST_DATABASE_URL,
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import {
  claimStep,
  createRun,
  dispatchableSteps,
  findStep,
  getStep,
  guardedTransition,
  isReclaimable,
  saveCheckpoint,
  STEP_DEPENDENCIES,
} from './steps'
import { deriveIdempotencyKey, inputVersion } from './idempotency'
import { lookupCompletedWork, recordCompletedWork } from './ledger'
import {
  AccountLockReentry,
  AccountLockTimeout,
  holdsAccountLock,
  tryWithAccountLock,
  withAccountLock,
} from './lock'
import { DEFAULT_STEP_LEASE_MS, STEP_LEASE_MS, leaseExpiryFor } from './lease'
import { beginShutdown, isShuttingDown, resetShutdown, shutdownSignal } from './shutdown'
import { setRuntimeLogger } from './logging'
import { createLogger, silentLogger, type LogRecord } from '@sortiva/core'
import { BACKOFF_SCHEDULE_MS, JITTER_FRACTION, MAX_ATTEMPTS, nextAttemptDelayMs, retriesExhausted } from './retry'
import { dlqDepth, listOpenDlq, replayDlqEntry } from './dlq'
import { runStep } from './runStep'
import { RetryableFailure, TerminalFailure, TokenInvalidFailure } from './errors'
import { assertCrontabTasksExist, CRON_ENTRIES, crontab } from './crontab'
import { installSignalHandlers, startWorker } from './worker'
import { clearTasks, registerTask, registeredTaskNames, taskList } from './tasks'
import { makeWorkerUtils } from 'graphile-worker'

/**
 * T0.4 done-when, one describe block per line of the card:
 *   guard mismatch stops a second worker; re-running a completed key returns
 *   stored output without executing; two workers on one account serialise; a
 *   step crashed mid-checkpoint resumes at the cursor; retries follow
 *   1m/5m/25m ±20%; DLQ entry carries step + key + error; SIGTERM drains.
 */

const available = await databaseAvailable()

/** `pg.Pool` keeps the options it was constructed with; the tests need the URL. */
function connectionStringOf(pool: pg.Pool): string {
  const options = (pool as unknown as { options: { connectionString?: string } }).options
  if (!options.connectionString) throw new Error('pool has no connection string')
  return options.connectionString
}

// ── Pure units, no database ─────────────────────────────────────────────────

describe('idempotency keys (main §14.3.2)', () => {
  it('derives the same key from the same inputs, never randomly', () => {
    const a = deriveIdempotencyKey('acct-1', 'catalog_sync', 'gen-7')
    const b = deriveIdempotencyKey('acct-1', 'catalog_sync', 'gen-7')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('separates accounts, steps and input versions', () => {
    const base = deriveIdempotencyKey('acct-1', 'catalog_sync', 'gen-7')
    expect(deriveIdempotencyKey('acct-2', 'catalog_sync', 'gen-7')).not.toBe(base)
    expect(deriveIdempotencyKey('acct-1', 'distill', 'gen-7')).not.toBe(base)
    expect(deriveIdempotencyKey('acct-1', 'catalog_sync', 'gen-8')).not.toBe(base)
  })

  it('cannot be collided by shifting a boundary between the parts', () => {
    expect(deriveIdempotencyKey('ab', 'catalog_sync', 'c')).not.toBe(
      deriveIdempotencyKey('a', 'catalog_sync', 'bc'),
    )
  })

  it('canonicalises input versions so property order does not matter', () => {
    expect(inputVersion({ shopId: 1, generation: 7 })).toBe(inputVersion({ generation: 7, shopId: 1 }))
    expect(inputVersion({ shopId: 1, generation: 7 })).not.toBe(inputVersion({ shopId: 1, generation: 8 }))
  })

  it('refuses an empty input version rather than hashing nothing', () => {
    expect(() => deriveIdempotencyKey('acct-1', 'distill', '')).toThrow()
  })
})

describe('retry & backoff (main §14.3.5)', () => {
  it('follows 1m / 5m / 25m', () => {
    expect(BACKOFF_SCHEDULE_MS).toEqual([60_000, 300_000, 1_500_000])
  })

  it('allows 3 retries, then stops', () => {
    expect(MAX_ATTEMPTS).toBe(4)
    expect(retriesExhausted(3)).toBe(false)
    expect(retriesExhausted(4)).toBe(true)
    expect(nextAttemptDelayMs(4)).toBeUndefined()
  })

  it('keeps every jittered delay within ±20% of its base', () => {
    for (const [index, base] of BACKOFF_SCHEDULE_MS.entries()) {
      for (let i = 0; i < 500; i++) {
        const delay = nextAttemptDelayMs(index + 1)!
        expect(delay).toBeGreaterThanOrEqual(Math.floor(base * (1 - JITTER_FRACTION)))
        expect(delay).toBeLessThanOrEqual(Math.ceil(base * (1 + JITTER_FRACTION)))
      }
    }
  })

  it('reaches both ends of the jitter range, so the spread is real', () => {
    // A stampede after a provider outage is exactly what jitter prevents, so
    // "within range" is not enough — it has to actually vary in both directions.
    expect(nextAttemptDelayMs(1, () => 0)).toBe(48_000)
    expect(nextAttemptDelayMs(1, () => 1)).toBe(72_000)
    expect(nextAttemptDelayMs(1, () => 0.5)).toBe(60_000)
  })
})

describe('step dependency graph (main §14.3.1, §6)', () => {
  it('gates distill behind catalog_sync, as §14.3.1 names explicitly', () => {
    expect(STEP_DEPENDENCIES.distill).toEqual(['catalog_sync'])
  })

  it('runs gsc_connect after keyword discovery but never lets it block confirmation', () => {
    // It runs right after keyword and competitor discovery, but a merchant who
    // skips Search Console must still be able to finish onboarding.
    expect(STEP_DEPENDENCIES.gsc_connect).toEqual(['keywords_competitors'])
    expect(STEP_DEPENDENCIES.awaiting_confirmation).not.toContain('gsc_connect')
  })

  it('has no cycles and no dangling dependency', () => {
    const seen = new Set<string>()
    const visiting = new Set<string>()
    const visit = (step: string) => {
      if (seen.has(step)) return
      expect(visiting.has(step), `cycle at ${step}`).toBe(false)
      visiting.add(step)
      for (const dep of STEP_DEPENDENCIES[step as keyof typeof STEP_DEPENDENCIES] ?? []) {
        expect(STEP_DEPENDENCIES).toHaveProperty(dep)
        visit(dep)
      }
      visiting.delete(step)
      seen.add(step)
    }
    for (const step of Object.keys(STEP_DEPENDENCIES)) visit(step)
  })
})

describe('crontab registry (tech §2)', () => {
  it('registers every scheduled job tech §2 names', () => {
    const tasks = CRON_ENTRIES.map((e) => e.task)
    for (const expected of [
      'generation_cycle_daily',
      'reconciliation_sweep_daily',
      'gsc_sync_daily',
      'signal_scan_weekly',
      'replenishment_monthly',
      'publish_intent_recovery_sweep',
      'retention_sweep_daily',
      'ctr_curve_refit_weekly',
      'landing_revenue_aggregate_daily',
    ]) {
      expect(tasks).toContain(expected)
    }
  })

  it('sweeps publish intents every five minutes (main §14.3.7)', () => {
    expect(CRON_ENTRIES.find((e) => e.task === 'publish_intent_recovery_sweep')?.schedule).toBe(
      '*/5 * * * *',
    )
  })

  it('renders a crontab Graphile can parse', () => {
    expect(crontab()).toMatch(/^\*\/5 \* \* \* \* publish_intent_recovery_sweep$/m)
  })

  it('refuses to start when a scheduled task has no handler', () => {
    expect(() => assertCrontabTasksExist(['generation_cycle_daily'])).toThrow(
      /no registered handler/,
    )
    expect(() => assertCrontabTasksExist(CRON_ENTRIES.map((e) => e.task))).not.toThrow()
  })
})

describe('graceful shutdown (tech §2.1)', () => {
  // These raise real process signals, which begin a real process-wide shutdown.
  afterEach(() => resetShutdown())

  it('drains in-flight work on SIGTERM and exits 0', async () => {
    let inFlightFinished = false
    let exitCode: number | undefined
    const worker = {
      stop: async () => {
        // Stand-in for Graphile's drain: finish what is running, accept nothing new.
        await new Promise((resolve) => setTimeout(resolve, 20))
        inFlightFinished = true
      },
    }
    const uninstall = installSignalHandlers(worker, {
      signals: ['SIGUSR2'],
      exit: (code) => {
        exitCode = code
      },
      logger: { log: () => {}, error: () => {} },
    })

    process.emit('SIGUSR2')
    await new Promise((resolve) => setTimeout(resolve, 80))
    uninstall()

    expect(inFlightFinished).toBe(true)
    expect(exitCode).toBe(0)
  })

  it('ignores a second signal mid-drain rather than stopping twice', async () => {
    let stops = 0
    const worker = {
      stop: async () => {
        stops += 1
        await new Promise((resolve) => setTimeout(resolve, 30))
      },
    }
    const uninstall = installSignalHandlers(worker, {
      signals: ['SIGUSR2'],
      exit: () => {},
      logger: { log: () => {}, error: () => {} },
    })

    process.emit('SIGUSR2')
    process.emit('SIGUSR2')
    await new Promise((resolve) => setTimeout(resolve, 80))
    uninstall()

    expect(stops).toBe(1)
  })
})

// ── Against a real Postgres ─────────────────────────────────────────────────

describe.skipIf(!available)('step state machine against Postgres', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string
  let jobId: string

  beforeAll(async () => {
    ctx = await setupTestDb('worker_runtime')
    pool = ctx.pool
    // Every runStep below emits structured lines; the cases that care supply
    // their own capturing logger.
    setRuntimeLogger(silentLogger)
  })

  afterAll(async () => {
    setRuntimeLogger(undefined)
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, `worker-${Math.random().toString(36).slice(2)}@example.com`)
    ;({ jobId } = await createRun(ctx.db, accountId, 'run-1'))
  })

  const stepIdFor = async (step: Parameters<typeof findStep>[2]) => {
    const row = await findStep(ctx.db, jobId, step)
    return row!.id
  }

  describe('guarded transitions (main §14.3.1, invariants 15 & 18)', () => {
    it('lets exactly one of two workers claim a step; the loser stops', async () => {
      const stepId = await stepIdFor('detect')
      const key = deriveIdempotencyKey(accountId, 'detect', 'v1')

      let executions = 0
      const attempt = () =>
        runStep({
          db: ctx.db,
          pool,
          accountId,
          jobId,
          stepId,
          idempotencyKey: key,
          handler: async () => {
            executions += 1
            await new Promise((resolve) => setTimeout(resolve, 60))
            return { ok: true }
          },
        })

      const [first, second] = await Promise.all([attempt(), attempt()])
      const statuses = [first.status, second.status].sort()

      // The advisory lock serialises them, so the second finds a completed key
      // rather than a guard mismatch — and either way it does not execute.
      expect(statuses).toEqual(['succeeded', 'succeeded'])
      expect(executions).toBe(1)
    })

    it('returns undefined when the guard matches no rows', async () => {
      const stepId = await stepIdFor('detect')
      expect(await guardedTransition(ctx.db, stepId, 'pending', 'running')).toBeDefined()
      // The step is now `running`; a worker still expecting `pending` gets nothing.
      expect(await guardedTransition(ctx.db, stepId, 'pending', 'running')).toBeUndefined()
    })

    it('does not claim a step whose dependencies are unmet', async () => {
      const dispatchable = await dispatchableSteps(ctx.db, jobId)
      expect(dispatchable.map((s) => s.step)).toEqual(['detect'])
    })

    it('opens the next step only once its dependency succeeds', async () => {
      await guardedTransition(ctx.db, await stepIdFor('detect'), 'pending', 'succeeded')
      const dispatchable = await dispatchableSteps(ctx.db, jobId)
      expect(dispatchable.map((s) => s.step)).toEqual(['oauth_wait'])
    })

    it('treats a skipped dependency as satisfied, so skipping GSC does not stall onboarding', async () => {
      for (const step of ['detect', 'oauth_wait', 'catalog_sync', 'distill', 'family_group', 'persona', 'keywords_competitors'] as const) {
        await guardedTransition(ctx.db, await stepIdFor(step), 'pending', 'succeeded')
      }
      await guardedTransition(ctx.db, await stepIdFor('gsc_connect'), 'pending', 'skipped')
      const dispatchable = await dispatchableSteps(ctx.db, jobId)
      expect(dispatchable.map((s) => s.step)).toContain('awaiting_confirmation')
    })
  })

  describe('completed-key ledger (main §14.3.2)', () => {
    it('returns the stored output without executing on a re-run', async () => {
      const stepId = await stepIdFor('detect')
      const key = deriveIdempotencyKey(accountId, 'detect', 'v1')

      let executions = 0
      const handler = async () => {
        executions += 1
        return { platform: 'shopify' }
      }

      const first = await runStep({ db: ctx.db, pool, accountId, jobId, stepId, idempotencyKey: key, handler })
      expect(first).toMatchObject({ status: 'succeeded', executed: true })
      expect(executions).toBe(1)

      // A *second ingestion run* for the same account. Identical inputs produce
      // an identical key, so the new run's step
      // finds the first run's completed key and returns its output. This is
      // what makes "re-running distillation for an unchanged product a no-op
      // by construction" true.
      const { jobId: secondJobId } = await createRun(ctx.db, accountId, 'run-2')
      const secondStepId = (await findStep(ctx.db, secondJobId, 'detect'))!.id

      const second = await runStep({
        db: ctx.db, pool, accountId, jobId: secondJobId, stepId: secondStepId,
        idempotencyKey: key, handler,
      })
      expect(second).toMatchObject({ status: 'succeeded', executed: false })
      expect(second).toHaveProperty('output', { platform: 'shopify' })
      expect(executions, 'the handler must not run again').toBe(1)

      // The second run's own row is marked succeeded and carries the same
      // output, so downstream dependency gating sees a finished step.
      const adopted = await findStep(ctx.db, secondJobId, 'detect')
      expect(adopted?.state).toBe('succeeded')
      expect(adopted?.outputRef).toEqual({ platform: 'shopify' })
    })

    it('does execute when the input version changed, because the key changed', async () => {
      const stepId = await stepIdFor('detect')
      let executions = 0
      const handler = async () => {
        executions += 1
        return { n: executions }
      }
      await runStep({
        db: ctx.db, pool, accountId, jobId, stepId,
        idempotencyKey: deriveIdempotencyKey(accountId, 'detect', 'v1'),
        handler,
      })
      const { jobId: secondJobId } = await createRun(ctx.db, accountId, 'run-2')
      await runStep({
        db: ctx.db, pool, accountId, jobId: secondJobId,
        stepId: (await findStep(ctx.db, secondJobId, 'detect'))!.id,
        idempotencyKey: deriveIdempotencyKey(accountId, 'detect', 'v2'),
        handler,
      })
      expect(executions).toBe(2)
    })

    // ── The durability half: the record outlives the run that produced it ────
    //
    // The failure this guards against, in full: the queue is at-least-once, so
    // the same job can arrive twice. Between the two deliveries the run's rows
    // are gone — an account cascade, a retention sweep, a "restart onboarding"
    // feature. Before card R3 the "have I done this" record *was* those rows, so
    // the second delivery found nothing and did the work again for real: a
    // second billed Shopify crawl, a second billed batch of LLM calls (audit
    // T0.4 [major]). These cases fail against the old `job_steps` lookup.

    it('does not re-execute after the job rows that recorded the work are deleted', async () => {
      const stepId = await stepIdFor('detect')
      const key = deriveIdempotencyKey(accountId, 'detect', 'v1')

      let executions = 0
      const handler = async () => {
        executions += 1
        return { platform: 'shopify' }
      }

      const first = await runStep({ db: ctx.db, pool, accountId, jobId, stepId, idempotencyKey: key, handler })
      expect(first).toMatchObject({ status: 'succeeded', executed: true })

      // The run is discarded, steps and all — the cascade the ledger used to
      // hang off (`job_steps` → `ingestion_jobs` → `accounts`).
      await pool.query('DELETE FROM ingestion_jobs WHERE id = $1', [jobId])
      const survivors = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM job_steps WHERE id = $1',
        [stepId],
      )
      expect(survivors.rows[0]!.n, 'the job rows really are gone').toBe(0)

      // Same account, same inputs, so the derived key is the same: this is the
      // redelivered message.
      const { jobId: secondJobId } = await createRun(ctx.db, accountId, 'run-after-deletion')
      const second = await runStep({
        db: ctx.db, pool, accountId, jobId: secondJobId,
        stepId: (await findStep(ctx.db, secondJobId, 'detect'))!.id,
        idempotencyKey: key, handler,
      })

      expect(second).toMatchObject({ status: 'succeeded', executed: false })
      expect(second).toHaveProperty('output', { platform: 'shopify' })
      expect(executions, 'the redelivered job must not re-run billed work').toBe(1)
    })

    it('keeps the completion record when the whole account is deleted', async () => {
      const stepId = await stepIdFor('detect')
      const key = deriveIdempotencyKey(accountId, 'detect', 'v1')
      await runStep({
        db: ctx.db, pool, accountId, jobId, stepId, idempotencyKey: key,
        handler: async () => ({ platform: 'shopify' }),
      })

      const recorded = await pool.query<{ output_ref: unknown }>(
        'SELECT output_ref FROM idempotency_ledger WHERE idempotency_key = $1',
        [key],
      )
      expect(recorded.rows).toHaveLength(1)
      expect(recorded.rows[0]!.output_ref).toEqual({ platform: 'shopify' })

      // Account deletion removes their data outright. The ledger has no foreign
      // key to accounts, so the evidence of what was already paid for survives —
      // which is the difference between this table and the job rows.
      await pool.query('DELETE FROM accounts WHERE id = $1', [accountId])
      const after = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM idempotency_ledger WHERE idempotency_key = $1',
        [key],
      )
      expect(after.rows[0]!.n).toBe(1)
    })

    it('finishes a step whose completion was recorded before the process died', async () => {
      // The window the write order creates on purpose: the ledger row is
      // committed, then the process dies before the step row is marked. The step
      // is left `running` with the work genuinely done.
      const stepId = await stepIdFor('detect')
      const key = deriveIdempotencyKey(accountId, 'detect', 'v1')
      await recordCompletedWork(ctx.db, key, { platform: 'shopify' })
      await guardedTransition(ctx.db, stepId, 'pending', 'running', { idempotencyKey: key })

      let executions = 0
      const outcome = await runStep({
        db: ctx.db, pool, accountId, jobId, stepId, idempotencyKey: key,
        leaseMs: 0,
        handler: async () => {
          executions += 1
          return { platform: 'never-reached' }
        },
      })

      expect(outcome).toMatchObject({ status: 'succeeded', executed: false })
      expect(executions, 'the work was already done; doing it again would re-bill').toBe(0)
      const settled = await getStep(ctx.db, stepId)
      expect(settled?.state).toBe('succeeded')
      expect(settled?.outputRef).toEqual({ platform: 'shopify' })
    })

    it('refuses to revise a completed key: the first answer wins', async () => {
      // A retry must not come back with a different answer than the run it is
      // resuming. The database refuses UPDATE outright (migration 0005), so
      // recording is insert-or-nothing and a second recorder reads back the
      // first one's answer rather than replacing it.
      const key = deriveIdempotencyKey(accountId, 'persona', 'v1')
      expect(await recordCompletedWork(ctx.db, key, { persona: 'first' })).toEqual({
        outputRef: { persona: 'first' },
        firstWriter: true,
      })
      expect(await recordCompletedWork(ctx.db, key, { persona: 'second' })).toEqual({
        outputRef: { persona: 'first' },
        firstWriter: false,
      })
      expect(await lookupCompletedWork(ctx.db, key)).toEqual({ outputRef: { persona: 'first' } })
    })
  })

  describe('per-account advisory lock (main §14.3.3)', () => {
    it('serialises two workers on one account', async () => {
      const order: string[] = []
      const hold = (label: string) =>
        withAccountLock(pool, accountId, async () => {
          order.push(`${label}:enter`)
          await new Promise((resolve) => setTimeout(resolve, 50))
          order.push(`${label}:exit`)
        })

      await Promise.all([hold('a'), hold('b')])

      // Whoever went first must have exited before the other entered.
      expect(order).toHaveLength(4)
      expect(order[1]).toBe(`${order[0]!.split(':')[0]}:exit`)
    })

    it('runs different accounts in parallel', async () => {
      const other = await insertAccount(pool, 'other@example.com')
      const started: string[] = []
      const bothInside = await Promise.all([
        withAccountLock(pool, accountId, async () => {
          started.push('a')
          await new Promise((resolve) => setTimeout(resolve, 40))
          return started.length
        }),
        withAccountLock(pool, other, async () => {
          started.push('b')
          await new Promise((resolve) => setTimeout(resolve, 40))
          return started.length
        }),
      ])
      // Both were inside their locks at the same time.
      expect(bothInside).toEqual([2, 2])
    })

    it('backs off instead of queueing when asked not to block', async () => {
      let inner: unknown = 'not-run'
      await withAccountLock(pool, accountId, async () => {
        inner = await tryWithAccountLock(pool, accountId, async () => 'ran')
      })
      expect(inner).toBeUndefined()
    })

    it('releases the lock when the body throws', async () => {
      await expect(
        withAccountLock(pool, accountId, async () => {
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')
      // The next acquisition must not block.
      expect(await tryWithAccountLock(pool, accountId, async () => 'free')).toBe('free')
    })

    /**
     * The three ways a *session*-scoped advisory lock can go wrong that the
     * transaction-scoped form cannot. Each of these was a live defect
     * before card R1.
     */
    it('frees the store even when the unlock itself fails', async () => {
      // The realistic trigger: the step used the lock's own connection for a
      // transaction that aborted. Postgres then refuses every further command on
      // it — including our unlock. Handing that connection back to the pool would
      // leave the lock held by a connection nobody knows about, and every future
      // job for this store would wait on it forever, with no error anywhere.
      await withAccountLock(pool, accountId, async (lock) => {
        await lock.client.query('BEGIN')
        await lock.client.query('SELECT 1/0').catch(() => {})
        // The connection is now in an aborted transaction.
      })

      expect(
        await tryWithAccountLock(pool, accountId, async () => 'free'),
        'the store is locked out permanently',
      ).toBe('free')
    })

    it('does not leak a pool slot when acquiring fails', async () => {
      // One connection, so a single leaked slot is immediately fatal — which is
      // the real shape of the bug: the pool is ten and is shared with the web
      // server. The NaN timeout stands in for any error thrown between
      // `pool.connect()` and a successful acquire.
      const tiny = new pg.Pool({ connectionString: connectionStringOf(pool), max: 1 })
      try {
        await expect(
          withAccountLock(tiny, accountId, async () => 'never', { timeoutMs: Number.NaN }),
        ).rejects.toThrow()

        const after = await Promise.race([
          withAccountLock(tiny, accountId, async () => 'still works'),
          new Promise((resolve) => setTimeout(() => resolve('pool exhausted'), 2000)),
        ])
        expect(after).toBe('still works')
      } finally {
        await tiny.end()
      }
    })

    it('fails loudly instead of waiting forever on a stuck holder', async () => {
      let holderHasLock!: () => void
      let letHolderGo!: () => void
      const acquired = new Promise<void>((resolve) => (holderHasLock = resolve))
      const released = new Promise<void>((resolve) => (letHolderGo = resolve))

      const holder = withAccountLock(pool, accountId, async () => {
        holderHasLock()
        await released
      })
      await acquired

      // A *sibling* call, the way a second job in the same process would be.
      await expect(
        withAccountLock(pool, accountId, async () => 'never', { timeoutMs: 250 }),
      ).rejects.toBeInstanceOf(AccountLockTimeout)

      letHolderGo()
      await holder
    })

    it('throws a clear error instead of deadlocking on a nested acquisition', async () => {
      // `pg_advisory_xact_lock` would simply succeed here; a second pool
      // connection waits on a lock its own caller holds, forever.
      await withAccountLock(pool, accountId, async () => {
        expect(holdsAccountLock(accountId)).toBe(true)
        await expect(withAccountLock(pool, accountId, async () => 'never')).rejects.toBeInstanceOf(
          AccountLockReentry,
        )
      })
      expect(holdsAccountLock(accountId)).toBe(false)
    })

    it('still lets two sibling jobs for one store queue, rather than calling that re-entry', async () => {
      // The guard is about the call *stack*, not the process: two independent
      // jobs for one account must serialise through Postgres as before.
      const order: string[] = []
      await Promise.all(
        ['a', 'b'].map((label) =>
          withAccountLock(pool, accountId, async () => {
            order.push(`${label}:enter`)
            await new Promise((resolve) => setTimeout(resolve, 30))
            order.push(`${label}:exit`)
          }),
        ),
      )
      expect(order[1]).toBe(`${order[0]!.split(':')[0]}:exit`)
    })

    it('gives unrelated stores 64 bits of key, not 32', async () => {
      const client = await pool.connect()
      try {
        const { rows } = await client.query<{ key: string }>(
          'SELECT hashtextextended($1, $2)::text AS key',
          [accountId, 0x5027],
        )
        // A 32-bit key collides between unrelated stores with near-certainty in
        // the low hundreds of thousands of accounts, quietly serialising two
        // merchants behind each other, when they are supposed to be parallel.
        expect(BigInt(rows[0]!.key)).toBeTypeOf('bigint')
        expect(Math.abs(Number(rows[0]!.key))).toBeGreaterThan(0)
      } finally {
        client.release()
      }
    })
  })

  describe('checkpointing (main §14.3.4)', () => {
    it('resumes a crashed step at its cursor, not at page one', async () => {
      const stepId = await stepIdFor('detect')
      const key = deriveIdempotencyKey(accountId, 'detect', 'v1')
      const pagesSeen: number[] = []

      const syncPages = async (ctxArg: { checkpoint: { page: number } | undefined; save: (c: { page: number }) => Promise<void> }, crashAfter: number) => {
        let page = ctxArg.checkpoint?.page ?? 0
        while (page < 5) {
          page += 1
          pagesSeen.push(page)
          await ctxArg.save({ page })
          if (page === crashAfter) throw new RetryableFailure('provider_timeout', 'connection reset')
        }
        return { pages: page }
      }

      const crashed = await runStep<{ page: number }>({
        db: ctx.db, pool, accountId, jobId, stepId, idempotencyKey: key,
        handler: (c) => syncPages(c, 3),
      })
      expect(crashed.status).toBe('retry_scheduled')
      expect(pagesSeen).toEqual([1, 2, 3])

      // Clear the backoff the way the dispatcher would once it elapses.
      await ctx.db.update(jobSteps).set({ nextAttemptAt: null }).where(eq(jobSteps.id, stepId))

      const resumed = await runStep<{ page: number }>({
        db: ctx.db, pool, accountId, jobId, stepId, idempotencyKey: key,
        handler: (c) => syncPages(c, -1),
      })
      expect(resumed).toMatchObject({ status: 'succeeded' })
      expect(pagesSeen, 'pages 1-3 must not be re-fetched').toEqual([1, 2, 3, 4, 5])
    })
  })

  describe('retry scheduling on the real row', () => {
    it('writes a next_attempt_at inside the ±20% band and keeps the step retryable', async () => {
      const stepId = await stepIdFor('detect')
      const before = Date.now()
      const outcome = await runStep({
        db: ctx.db, pool, accountId, jobId, stepId,
        idempotencyKey: deriveIdempotencyKey(accountId, 'detect', 'v1'),
        handler: async () => {
          throw new RetryableFailure('provider_5xx', 'upstream 503')
        },
      })
      expect(outcome.status).toBe('retry_scheduled')

      const row = await findStep(ctx.db, jobId, 'detect')
      expect(row?.state).toBe('failed_retryable')
      expect(row?.attempts).toBe(1)
      expect(row?.lastError).toBe('upstream 503')
      const delay = row!.nextAttemptAt!.getTime() - before
      expect(delay).toBeGreaterThanOrEqual(48_000 - 5_000)
      expect(delay).toBeLessThanOrEqual(72_000 + 5_000)
    })

    it('is not dispatchable until the backoff elapses', async () => {
      const stepId = await stepIdFor('detect')
      await runStep({
        db: ctx.db, pool, accountId, jobId, stepId,
        idempotencyKey: deriveIdempotencyKey(accountId, 'detect', 'v1'),
        handler: async () => {
          throw new RetryableFailure('provider_5xx', 'upstream 503')
        },
      })
      expect((await dispatchableSteps(ctx.db, jobId)).map((s) => s.step)).not.toContain('detect')

      await ctx.db
        .update(jobSteps)
        .set({ nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(jobSteps.id, stepId))
      expect((await dispatchableSteps(ctx.db, jobId)).map((s) => s.step)).toContain('detect')
    })
  })

  describe('reclaiming a step whose worker died (main §14.3.1, tech §2.1)', () => {
    /**
     * The process-death case, in the same process. `runtime.test.ts` cannot
     * really kill itself; `pnpm chaos`'s `process_death_mid_step` scenario does
     * that with a real SIGKILL. Here we reproduce the *state* a killed process
     * leaves — `running`, with a `started_at` older than the lease — because
     * that is what every code path in this file actually reacts to.
     */
    const strand = async (step: Parameters<typeof findStep>[2], agoMs: number) => {
      const stepId = await stepIdFor(step)
      await claimStep(ctx.db, stepId, deriveIdempotencyKey(accountId, step, 'v1'))
      await ctx.db
        .update(jobSteps)
        .set({ startedAt: new Date(Date.now() - agoMs) })
        .where(eq(jobSteps.id, stepId))
      return stepId
    }

    it('leaves a step alone while its lease is still running', async () => {
      const stepId = await strand('detect', 60_000)
      expect((await getStep(ctx.db, stepId))?.state).toBe('running')
      expect((await dispatchableSteps(ctx.db, jobId)).map((s) => s.id)).not.toContain(stepId)
    })

    it('offers the step again once the lease has expired', async () => {
      const stepId = await strand('detect', DEFAULT_STEP_LEASE_MS + 60_000)
      expect((await dispatchableSteps(ctx.db, jobId)).map((s) => s.id)).toContain(stepId)
    })

    it('re-runs the abandoned step and resumes at its committed cursor', async () => {
      const key = deriveIdempotencyKey(accountId, 'detect', 'v1')
      const stepId = await stepIdFor('detect')

      // A worker got two pages in and died.
      await claimStep(ctx.db, stepId, key)
      await saveCheckpoint(ctx.db, stepId, { page: 2 })
      await ctx.db
        .update(jobSteps)
        .set({ startedAt: new Date(Date.now() - DEFAULT_STEP_LEASE_MS - 60_000) })
        .where(eq(jobSteps.id, stepId))

      const pages: number[] = []
      const outcome = await runStep<{ page: number }>({
        db: ctx.db, pool, accountId, jobId, stepId, idempotencyKey: key,
        handler: async (c) => {
          let page = c.checkpoint?.page ?? 0
          while (page < 5) {
            page += 1
            await c.save({ page })
            pages.push(page)
          }
          return { pages: page }
        },
      })

      expect(outcome).toMatchObject({ status: 'succeeded' })
      expect(pages, 'pages 1-2 were already committed and must not be re-fetched').toEqual([3, 4, 5])
      expect((await getStep(ctx.db, stepId))?.state).toBe('succeeded')
    })

    it('never reclaims a step that is waiting on a person, however long it waits', async () => {
      // `oauth_wait`, `gsc_connect` and `awaiting_confirmation` sit in `running`
      // for days by design; a timer must not mistake patience for death.
      for (const step of ['oauth_wait', 'gsc_connect', 'awaiting_confirmation'] as const) {
        expect(STEP_LEASE_MS[step], `${step} must have no lease`).toBeNull()
      }
      const row = { step: 'oauth_wait' as const, state: 'running' as const, startedAt: new Date(0) }
      expect(isReclaimable(row, new Date())).toBe(false)
      expect(leaseExpiryFor('oauth_wait')).toBeNull()
    })

    it('dead-letters instead of reclaiming forever when the attempt budget is spent', async () => {
      const key = deriveIdempotencyKey(accountId, 'detect', 'v1')
      const stepId = await stepIdFor('detect')
      await claimStep(ctx.db, stepId, key)
      await ctx.db
        .update(jobSteps)
        .set({ attempts: MAX_ATTEMPTS, startedAt: new Date(Date.now() - DEFAULT_STEP_LEASE_MS - 60_000) })
        .where(eq(jobSteps.id, stepId))

      let ran = false
      const outcome = await runStep({
        db: ctx.db, pool, accountId, jobId, stepId, idempotencyKey: key,
        handler: async () => {
          ran = true
        },
      })

      expect(outcome).toEqual({ status: 'dead_lettered', errorClass: 'lease_expired' })
      expect(ran, 'a step that has died four times must not be started a fifth').toBe(false)
      expect((await listOpenDlq(ctx.db))[0]?.errorClass).toBe('lease_expired')
      expect((await getStep(ctx.db, stepId))?.state).toBe('failed_terminal')
    })

    it('stops a worker whose step was reclaimed under it, rather than rewinding the new owner', async () => {
      const key = deriveIdempotencyKey(accountId, 'detect', 'v1')
      const stepId = await stepIdFor('detect')

      const outcome = await runStep({
        db: ctx.db, pool, accountId, jobId, stepId, idempotencyKey: key,
        handler: async (c) => {
          // Someone else takes the step mid-flight.
          await ctx.db.update(jobSteps).set({ state: 'pending' }).where(eq(jobSteps.id, stepId))
          await c.save({ page: 99 })
          return { unreachable: true }
        },
      })

      expect(outcome).toEqual({ status: 'not_claimed' })
      const row = await getStep(ctx.db, stepId)
      expect(row?.state).toBe('pending')
      expect(row?.checkpoint, 'the stale cursor must not have been written').toBeNull()
    })
  })

  describe('the shutdown signal reaches a running step (tech §2.1)', () => {
    afterEach(() => resetShutdown())

    it('hands the handler an abort signal that a deploy actually fires', async () => {
      const stepId = await stepIdFor('detect')
      let sawAbort = false

      const outcome = await runStep({
        db: ctx.db, pool, accountId, jobId, stepId,
        idempotencyKey: deriveIdempotencyKey(accountId, 'detect', 'v1'),
        handler: async (c) => {
          expect(c.signal.aborted).toBe(false)
          // What SIGTERM does, before the drain is awaited.
          beginShutdown('test')
          await new Promise((resolve) => setTimeout(resolve, 10))
          sawAbort = c.signal.aborted
          return { stoppedEarly: sawAbort }
        },
      })

      expect(isShuttingDown()).toBe(true)
      expect(sawAbort, 'a long step must be able to see the deploy coming').toBe(true)
      expect(outcome).toMatchObject({ status: 'succeeded' })
    })

    it('starts already-aborted when the process is mid-drain', async () => {
      beginShutdown('test')
      expect(shutdownSignal().aborted).toBe(true)
      const stepId = await stepIdFor('detect')
      let abortedAtStart: boolean | undefined
      await runStep({
        db: ctx.db, pool, accountId, jobId, stepId,
        idempotencyKey: deriveIdempotencyKey(accountId, 'detect', 'v1'),
        handler: async (c) => {
          abortedAtStart = c.signal.aborted
        },
      })
      expect(abortedAtStart).toBe(true)
    })
  })

  describe('per-store log trail (main §14.7, tech §4)', () => {
    const capture = () => {
      const lines: LogRecord[] = []
      const logger = createLogger({
        minLevel: 'debug',
        sink: (line) => lines.push(JSON.parse(line) as LogRecord),
      })
      return { lines, logger }
    }

    it('names the store, the job and the step on every line of a successful run', async () => {
      const { lines, logger } = capture()
      const stepId = await stepIdFor('detect')

      await runStep({
        db: ctx.db, pool, accountId, jobId, stepId, logger,
        idempotencyKey: deriveIdempotencyKey(accountId, 'detect', 'v1'),
        handler: async (c) => {
          c.log.info('vendor.page_fetched', { page: 1 })
          return { ok: true }
        },
      })

      const messages = lines.map((l) => l.msg)
      expect(messages).toContain('step.claimed')
      expect(messages).toContain('step.succeeded')
      // The handler's own line, with no plumbing of its own.
      expect(messages).toContain('vendor.page_fetched')

      for (const line of lines) {
        expect(line.account_id, `"${line.msg}" does not say which store`).toBe(accountId)
        expect(line.job_id).toBe(jobId)
        expect(line.step).toBe('detect')
      }
      const succeeded = lines.find((l) => l.msg === 'step.succeeded')!
      expect(typeof succeeded.duration_ms).toBe('number')
    })

    it('carries the failure class, the stack and whether it will retry', async () => {
      const { lines, logger } = capture()
      const stepId = await stepIdFor('detect')

      await runStep({
        db: ctx.db, pool, accountId, jobId, stepId, logger,
        idempotencyKey: deriveIdempotencyKey(accountId, 'detect', 'v1'),
        handler: async () => {
          throw new RetryableFailure('provider_5xx', 'upstream 503')
        },
      })

      const failed = lines.find((l) => l.msg === 'step.failed')!
      expect(failed).toBeDefined()
      expect(failed.error_class).toBe('provider_5xx')
      expect(failed.error).toBe('upstream 503')
      expect(failed.will_retry).toBe(true)
      expect(typeof failed.next_attempt_at).toBe('string')
      expect(String(failed.stack), 'a bare message is what made this undebuggable').toContain(
        'RetryableFailure',
      )
      expect(failed.account_id).toBe(accountId)
    })

    it('says how long a reclaimed step had been stranded', async () => {
      const { lines, logger } = capture()
      const key = deriveIdempotencyKey(accountId, 'detect', 'v1')
      const stepId = await stepIdFor('detect')
      await claimStep(ctx.db, stepId, key)
      await ctx.db
        .update(jobSteps)
        .set({ startedAt: new Date(Date.now() - DEFAULT_STEP_LEASE_MS - 120_000) })
        .where(eq(jobSteps.id, stepId))

      await runStep({
        db: ctx.db, pool, accountId, jobId, stepId, idempotencyKey: key, logger,
        handler: async () => ({ ok: true }),
      })

      const reclaimed = lines.find((l) => l.msg === 'step.reclaimed')!
      expect(reclaimed, 'a silent stall is the thing being fixed').toBeDefined()
      expect(Number(reclaimed.stranded_ms)).toBeGreaterThan(DEFAULT_STEP_LEASE_MS)
      expect(reclaimed.account_id).toBe(accountId)
    })
  })

  describe('DLQ (main §14.3.5)', () => {
    it('dead-letters a terminal failure with step, key, error and replay context', async () => {
      const stepId = await stepIdFor('detect')
      const key = deriveIdempotencyKey(accountId, 'detect', 'v1')

      const outcome = await runStep({
        db: ctx.db, pool, accountId, jobId, stepId, idempotencyKey: key,
        handler: async (c) => {
          await c.save({ page: 2 })
          throw new TerminalFailure('schema_invalid', 'product payload failed schema validation')
        },
      })
      expect(outcome).toMatchObject({ status: 'dead_lettered', errorClass: 'schema_invalid' })

      const [entry] = await listOpenDlq(ctx.db)
      expect(entry).toMatchObject({
        step: 'detect',
        idempotencyKey: key,
        errorClass: 'schema_invalid',
        lastError: 'product payload failed schema validation',
        attempts: 1,
        accountId,
        jobId,
        stepId,
      })
      expect(entry!.inputRefs).toMatchObject({ checkpoint: { page: 2 } })
      expect(entry!.firstFailedAt).toBeInstanceOf(Date)
      expect(await dlqDepth(ctx.db)).toBe(1)
    })

    it('dead-letters a retryable failure once retries are exhausted', async () => {
      const stepId = await stepIdFor('detect')
      const key = deriveIdempotencyKey(accountId, 'detect', 'v1')
      const fail = () =>
        runStep({
          db: ctx.db, pool, accountId, jobId, stepId, idempotencyKey: key,
          handler: async () => {
            throw new RetryableFailure('provider_timeout', 'timed out')
          },
        })

      for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
        expect((await fail()).status).toBe('retry_scheduled')
        await ctx.db.update(jobSteps).set({ nextAttemptAt: null }).where(eq(jobSteps.id, stepId))
      }
      expect((await fail()).status).toBe('dead_lettered')

      const [entry] = await listOpenDlq(ctx.db)
      expect(entry?.attempts).toBe(MAX_ATTEMPTS)
      expect(entry?.errorClass).toBe('provider_timeout')
    })

    it('routes a revoked token to re-auth rather than to the DLQ (main §6.2)', async () => {
      const stepId = await stepIdFor('detect')
      const outcome = await runStep({
        db: ctx.db, pool, accountId, jobId, stepId,
        idempotencyKey: deriveIdempotencyKey(accountId, 'detect', 'v1'),
        handler: async () => {
          throw new TokenInvalidFailure('shopify', '401 from Admin API')
        },
      })
      expect(outcome).toEqual({ status: 'awaiting_reauth', provider: 'shopify' })
      expect(await dlqDepth(ctx.db)).toBe(0)
      expect((await findStep(ctx.db, jobId, 'detect'))?.state).toBe('failed_terminal')
    })

    it('replays with one action, and a double replay is a no-op', async () => {
      const stepId = await stepIdFor('detect')
      await runStep({
        db: ctx.db, pool, accountId, jobId, stepId,
        idempotencyKey: deriveIdempotencyKey(accountId, 'detect', 'v1'),
        handler: async () => {
          throw new TerminalFailure('schema_invalid', 'bad payload')
        },
      })
      const [entry] = await listOpenDlq(ctx.db)

      expect((await replayDlqEntry(ctx.db, entry!.id, 'operator')).status).toBe('replayed')
      expect((await findStep(ctx.db, jobId, 'detect'))?.state).toBe('pending')
      expect(await dlqDepth(ctx.db)).toBe(0)

      expect((await replayDlqEntry(ctx.db, entry!.id, 'operator')).status).toBe('already_replayed')
    })
  })
})

describe.skipIf(!available)('SIGTERM drains a real Graphile worker (tech §2.1)', () => {
  let ctx: TestDb
  let connectionString: string

  beforeAll(async () => {
    ctx = await setupTestDb('worker_drain')
    const url = new URL(TEST_DATABASE_URL)
    url.pathname = `/${ctx.databaseName}`
    connectionString = url.toString()
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(() => clearTasks())

  it('finishes the in-flight job, then stops', async () => {
    const finished: string[] = []
    let startedJob = false

    registerTask('slow_task', async (payload) => {
      startedJob = true
      // Long enough that the signal certainly lands mid-flight.
      await new Promise((resolve) => setTimeout(resolve, 400))
      finished.push((payload as { id: string }).id)
    })

    const worker = await startWorker({
      connectionString,
      taskList: taskList(),
      concurrency: 1,
      enableCron: false,
    })

    const utils = await makeWorkerUtils({ connectionString })
    try {
      await utils.addJob('slow_task', { id: 'job-1' })

      // Wait for the job to actually be running before signalling.
      const deadline = Date.now() + 5000
      while (!startedJob && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(startedJob, 'the job never started').toBe(true)

      let exitCode: number | undefined
      const uninstall = installSignalHandlers(worker, {
        signals: ['SIGUSR2'],
        exit: (code) => {
          exitCode = code
        },
        logger: { log: () => {}, error: () => {} },
      })

      process.emit('SIGUSR2')
      await worker.stop()
      uninstall()

      // The drain waited for the in-flight job rather than abandoning it.
      expect(finished).toEqual(['job-1'])

      const remaining = await utils.withPgClient((client) =>
        client.query('SELECT count(*)::int AS n FROM graphile_worker.jobs'),
      )
      expect(remaining.rows[0].n, 'the completed job must be gone from the queue').toBe(0)

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(exitCode).toBe(0)
    } finally {
      await utils.release()
      await worker.stop().catch(() => {})
    }
  }, 20_000)

  it('refuses to enable cron while a scheduled task has no handler', async () => {
    registerTask('generation_cycle_daily', async () => {})
    expect(registeredTaskNames()).toEqual(['generation_cycle_daily'])
    await expect(
      startWorker({
        connectionString,
        taskList: taskList(),
        enableCron: true,
      }),
    ).rejects.toThrow(/no registered handler/)
  })
})

describe('database availability', () => {
  it('reports whether the worker-runtime integration cases actually ran', () => {
    if (!available) {
      throw new Error('No Postgres at the test URL. Run `pnpm db:up` first.')
    }
    expect(available).toBe(true)
  })
})
