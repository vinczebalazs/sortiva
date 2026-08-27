import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
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
import { createRun, dispatchableSteps, findStep, guardedTransition, STEP_DEPENDENCIES } from './steps'
import { deriveIdempotencyKey, inputVersion } from './idempotency'
import { withAccountLock, tryWithAccountLock } from './lock'
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
    // main §6.7 "runs right after keyword/competitor discovery and before
    // confirmation"; main §14.3.1 "never blocks awaiting_confirmation".
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
  })

  afterAll(async () => {
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

      // A *second ingestion run* for the same account. §14.3.2's guarantee is
      // that identical inputs produce an identical key, so the new run's step
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

      expect(await replayDlqEntry(ctx.db, entry!.id, 'operator')).toBeDefined()
      expect((await findStep(ctx.db, jobId, 'detect'))?.state).toBe('pending')
      expect(await dlqDepth(ctx.db)).toBe(0)

      expect(await replayDlqEntry(ctx.db, entry!.id, 'operator')).toBeUndefined()
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
