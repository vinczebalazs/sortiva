import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  accountScope,
  listActiveFlags,
  resetAccountFlag,
  resetGlobalFlag,
  systemScope,
  tripAccountFlag,
  tripGlobalFlag,
  type Db,
} from '@sortiva/db'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import {
  ACCOUNT_PAUSED_FLAG,
  ACCOUNT_PUBLISHING_PAUSED_FLAG,
  ALL_WORK_PAUSED_FLAG,
  PUBLISHING_PAUSED_FLAG,
  incidentFrom,
  reviewReset,
  silentLogger,
} from '@sortiva/core'
import {
  installKillSwitchReader,
  mayAccountPublishingRun,
  mayCallTypeRun,
  resetKillSwitchReader,
} from './gate'
import { clearTasks, registerTask, taskList } from './tasks'

/**
 * The switches, where they actually have to work: at the moment a job starts.
 *
 * The point of the wrapper these cases drive is that a lane cannot opt out of
 * it — registering a task is what puts it behind the switches — so the cases
 * register a task the ordinary way and then flip a switch, rather than calling
 * the gate directly. Calling the gate directly would prove only that the gate
 * works, which was already true before this card.
 */

const SYSTEM = systemScope('kill switches are global by definition')

let harness: TestDb
let db: Db

beforeAll(async () => {
  if (!(await databaseAvailable())) {
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before the test suite.')
  }
  harness = await setupTestDb('kill_switches')
  db = harness.db
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
  clearTasks()
  installKillSwitchReader(() => db)
})

afterEach(() => {
  clearTasks()
  resetKillSwitchReader()
})

/** Registers a task that records every time it actually ran. */
function countingTask(name: string): { ran: number[] } {
  const state = { ran: [] as number[] }
  registerTask(name, async () => {
    state.ran.push(Date.now())
  })
  return state
}

async function runTask(name: string, payload: unknown): Promise<void> {
  const task = taskList()[name]
  if (!task) throw new Error(`no task registered as "${name}"`)
  await task(payload, {} as never)
}

describe('flipping a switch stops work at the next dequeue', () => {
  it('runs an account job normally while nothing is paused', async () => {
    const account = await insertAccount(harness.pool, 'running@example.com')
    const task = countingTask('some_account_work')

    await runTask('some_account_work', { accountId: account })

    expect(task.ran).toHaveLength(1)
  })

  it('stops every account job on the very next run once global.pause_all is up', async () => {
    const account = await insertAccount(harness.pool, 'paused@example.com')
    const other = await insertAccount(harness.pool, 'other@example.com')
    const task = countingTask('some_account_work')

    await runTask('some_account_work', { accountId: account })
    expect(task.ran).toHaveLength(1)

    await tripGlobalFlag(db, SYSTEM, {
      flag: ALL_WORK_PAUSED_FLAG,
      actor: 'operator@sortiva',
      reason: 'a bad prompt version escaped the eval suite',
      trippedBy: 'manual',
    })

    // No restart, no cache expiry, no second tick: the very next dequeue reads
    // the switch out of the database and declines.
    await runTask('some_account_work', { accountId: account })
    await runTask('some_account_work', { accountId: other })

    expect(task.ran).toHaveLength(1)
  })

  it('stops work with no account attached too, since the master switch is about everybody', async () => {
    const task = countingTask('some_global_pass')

    await tripGlobalFlag(db, SYSTEM, {
      flag: ALL_WORK_PAUSED_FLAG,
      actor: 'operator@sortiva',
      reason: 'incident',
      trippedBy: 'manual',
    })
    await runTask('some_global_pass', {})

    expect(task.ran).toHaveLength(0)
  })

  it('stops only the paused store when the switch names one', async () => {
    const paused = await insertAccount(harness.pool, 'one@example.com')
    const fine = await insertAccount(harness.pool, 'two@example.com')
    const task = countingTask('some_account_work')

    await tripAccountFlag(db, accountScope(paused), {
      flag: ACCOUNT_PAUSED_FLAG,
      actor: 'spend_cap_sweep',
      reason: 'model spend reached $7.00 today',
      trippedBy: 'auto',
    })

    await runTask('some_account_work', { accountId: paused })
    await runTask('some_account_work', { accountId: fine })

    expect(task.ran).toHaveLength(1)
  })

  it('keeps the brake, the deletion sweep and the mail running while everything else is paused', async () => {
    // Pausing the product must not switch off the thing that would catch the
    // next runaway, the sweep that satisfies a deletion deadline, or the queue
    // that tells anybody what happened.
    const caps = countingTask('spend_cap_sweep')
    const retention = countingTask('retention_sweep_daily')
    const mail = countingTask('email_send_drain')
    const ordinary = countingTask('some_account_work')

    await tripGlobalFlag(db, SYSTEM, {
      flag: ALL_WORK_PAUSED_FLAG,
      actor: 'operator@sortiva',
      reason: 'incident',
      trippedBy: 'manual',
    })

    await runTask('spend_cap_sweep', {})
    await runTask('retention_sweep_daily', {})
    await runTask('email_send_drain', {})
    await runTask('some_account_work', { accountId: await insertAccount(harness.pool, 'x@e.com') })

    expect(caps.ran).toHaveLength(1)
    expect(retention.ran).toHaveLength(1)
    expect(mail.ran).toHaveLength(1)
    expect(ordinary.ran).toHaveLength(0)
  })

  it('does not fail the job it declined to run', async () => {
    // A paused job is not a broken job. If it threw, the queue would retry it,
    // burn its attempts and dead-letter it — turning an operator's pause into a
    // backlog of dead work to replay by hand.
    const account = await insertAccount(harness.pool, 'quiet@example.com')
    registerTask('some_account_work', async () => {
      throw new Error('this handler must never be reached')
    })
    await tripGlobalFlag(db, SYSTEM, {
      flag: ALL_WORK_PAUSED_FLAG,
      actor: 'operator@sortiva',
      reason: 'incident',
      trippedBy: 'manual',
    })

    await expect(runTask('some_account_work', { accountId: account })).resolves.toBeUndefined()
  })
})

describe('publishing pauses on its own, without stopping the writing', () => {
  it('lets generation continue while publishing is globally paused', async () => {
    const account = await insertAccount(harness.pool, 'publish@example.com')
    await tripGlobalFlag(db, SYSTEM, {
      flag: PUBLISHING_PAUSED_FLAG,
      actor: 'auto',
      reason: 'publish errors over the ceiling for an hour',
      trippedBy: 'auto',
    })

    expect(await mayAccountPublishingRun(db, account, silentLogger)).toEqual({
      allowed: false,
      reason: 'paused',
      flag: PUBLISHING_PAUSED_FLAG,
    })
    // The generation gate is untouched: drafts keep being written.
    const generation = countingTask('some_account_work')
    await runTask('some_account_work', { accountId: account })
    expect(generation.ran).toHaveLength(1)
  })

  it('pauses publishing for one store without touching the others', async () => {
    const paused = await insertAccount(harness.pool, 'a@example.com')
    const fine = await insertAccount(harness.pool, 'b@example.com')
    await tripAccountFlag(db, accountScope(paused), {
      flag: ACCOUNT_PUBLISHING_PAUSED_FLAG,
      actor: 'operator@sortiva',
      reason: 'merchant asked us to hold off',
      trippedBy: 'manual',
    })

    expect((await mayAccountPublishingRun(db, paused, silentLogger)).allowed).toBe(false)
    expect((await mayAccountPublishingRun(db, fine, silentLogger)).allowed).toBe(true)
  })

  it('stops publishing when everything is stopped', async () => {
    const account = await insertAccount(harness.pool, 'all@example.com')
    await tripGlobalFlag(db, SYSTEM, {
      flag: ALL_WORK_PAUSED_FLAG,
      actor: 'operator@sortiva',
      reason: 'incident',
      trippedBy: 'manual',
    })
    expect(await mayAccountPublishingRun(db, account, silentLogger)).toEqual({
      allowed: false,
      reason: 'paused',
      flag: ALL_WORK_PAUSED_FLAG,
    })
  })
})

describe('a per-call-type pause stops that call type and nothing else', () => {
  it('stops intent-gap analysis while leaving the rest of the store running', async () => {
    const account = await insertAccount(harness.pool, 'gap@example.com')
    await tripAccountFlag(db, accountScope(account), {
      flag: 'account.pause_intent_gap',
      actor: 'auto',
      reason: 'ten analyses today, which is the ceiling',
      trippedBy: 'auto',
    })

    expect(await mayCallTypeRun(db, account, 'intent_gap', silentLogger)).toMatchObject({
      allowed: false,
      flag: 'account.pause_intent_gap',
    })
    expect(await mayCallTypeRun(db, account, 'optimize_reco', silentLogger)).toEqual({
      allowed: true,
    })
    const pipeline = countingTask('some_account_work')
    await runTask('some_account_work', { accountId: account })
    expect(pipeline.ran).toHaveLength(1)
  })
})

describe('four eyes on a global switch', () => {
  it('refuses to lower a global switch on one person\'s say-so', async () => {
    const review = reviewReset({ flag: ALL_WORK_PAUSED_FLAG, operator: 'alice@sortiva' })
    expect(review).toMatchObject({ ok: false, code: 'second_operator_missing' })
  })

  it('refuses the same person twice', async () => {
    const review = reviewReset({
      flag: ALL_WORK_PAUSED_FLAG,
      operator: 'alice@sortiva',
      secondOperator: 'alice@sortiva',
    })
    expect(review).toMatchObject({ ok: false, code: 'same_operator_twice' })
  })

  it('never lets the product lower its own switch', async () => {
    expect(reviewReset({ flag: ALL_WORK_PAUSED_FLAG, operator: 'auto' })).toMatchObject({
      ok: false,
      code: 'automatic_actor',
    })
    expect(
      reviewReset({
        flag: ALL_WORK_PAUSED_FLAG,
        operator: 'alice@sortiva',
        secondOperator: 'auto',
      }),
    ).toMatchObject({ ok: false, code: 'second_operator_missing' })
  })

  it('lowers it for two named people, records both, and lets work start again', async () => {
    const account = await insertAccount(harness.pool, 'resume@example.com')
    const task = countingTask('some_account_work')
    await tripGlobalFlag(db, SYSTEM, {
      flag: ALL_WORK_PAUSED_FLAG,
      actor: 'auto',
      reason: 'judge fail rate over the ceiling',
      trippedBy: 'auto',
    })
    await runTask('some_account_work', { accountId: account })
    expect(task.ran).toHaveLength(0)

    const review = reviewReset({
      flag: ALL_WORK_PAUSED_FLAG,
      operator: 'alice@sortiva',
      secondOperator: 'bob@sortiva',
    })
    if (!review.ok) throw new Error('the review should have passed')
    const row = await resetGlobalFlag(db, SYSTEM, {
      flag: ALL_WORK_PAUSED_FLAG,
      resetBy: review.resetBy,
    })

    expect(row?.resetBy).toBe('alice@sortiva + bob@sortiva')
    await runTask('some_account_work', { accountId: account })
    expect(task.ran).toHaveLength(1)
  })

  it('lowers an account switch for one operator', async () => {
    const account = await insertAccount(harness.pool, 'single@example.com')
    await tripAccountFlag(db, accountScope(account), {
      flag: ACCOUNT_PAUSED_FLAG,
      actor: 'auto',
      reason: 'spend',
      trippedBy: 'auto',
    })
    const review = reviewReset({ flag: ACCOUNT_PAUSED_FLAG, operator: 'alice@sortiva' })
    if (!review.ok) throw new Error('an account switch needs one operator')

    const row = await resetAccountFlag(db, accountScope(account), {
      flag: ACCOUNT_PAUSED_FLAG,
      resetBy: review.resetBy,
    })
    expect(row?.resetBy).toBe('alice@sortiva')
  })

  it('lowers a switch once however many operators race for it', async () => {
    await tripGlobalFlag(db, SYSTEM, {
      flag: ALL_WORK_PAUSED_FLAG,
      actor: 'auto',
      reason: 'incident',
      trippedBy: 'auto',
    })
    const first = await resetGlobalFlag(db, SYSTEM, {
      flag: ALL_WORK_PAUSED_FLAG,
      resetBy: 'alice + bob',
    })
    const second = await resetGlobalFlag(db, SYSTEM, {
      flag: ALL_WORK_PAUSED_FLAG,
      resetBy: 'carol + dave',
    })
    expect(first).toBeDefined()
    // The record of who agreed is not overwritten by whoever came second.
    expect(second).toBeUndefined()
  })
})

describe('the open-incident list', () => {
  it('shows every switch that is up, and drops each one as it is lowered', async () => {
    const account = await insertAccount(harness.pool, 'incident@example.com')
    await tripGlobalFlag(db, SYSTEM, {
      flag: ALL_WORK_PAUSED_FLAG,
      actor: 'auto',
      reason: 'judge fail rate 68% over the last 50 drafts',
      trippedBy: 'auto',
    })
    await tripAccountFlag(db, accountScope(account), {
      flag: ACCOUNT_PAUSED_FLAG,
      actor: 'spend_cap_sweep',
      reason: 'model spend reached $7.00 today',
      trippedBy: 'auto',
    })

    const open = (await listActiveFlags(db, SYSTEM)).map(incidentFrom)
    expect(open).toHaveLength(2)
    expect(open.every((i) => i.automatic)).toBe(true)
    expect(open.every((i) => i.closedAt === null)).toBe(true)
    expect(open.find((i) => i.flag === ALL_WORK_PAUSED_FLAG)?.reason).toContain('68%')

    await resetGlobalFlag(db, SYSTEM, { flag: ALL_WORK_PAUSED_FLAG, resetBy: 'alice + bob' })
    expect((await listActiveFlags(db, SYSTEM)).map(incidentFrom)).toHaveLength(1)
  })
})
