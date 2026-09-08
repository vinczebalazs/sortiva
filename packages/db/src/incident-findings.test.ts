import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { systemScope, accountScope } from './scope'
import {
  addIncidentFinding,
  findActiveAccountFlag,
  findActiveGlobalFlag,
  findFlagById,
  listActiveFlags,
  listFindingsForFlags,
  listIncidentFindings,
  listRecentFlags,
  resetAccountFlag,
  resetGlobalFlag,
  tripAccountFlag,
  tripGlobalFlag,
} from './repositories/system'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from './testing'

/**
 * `R-INCIDENT-NOTES`. `incident_findings` holds what a person worked out after
 * a switch tripped, which may be days later and may be several notes.
 *
 * The case these tests exist for is the one the card said to establish rather
 * than assume: **a note has to still be there once the incident is closed.**
 * Lowering a switch updates the flag row instead of replacing it, so the note
 * keeps pointing at the incident it explains — but that is a property of the
 * reset code, not of the schema, and nothing would fail if a later change made
 * reset a delete-and-reinsert. These cases would.
 */

let harness: TestDb
const system = systemScope('incidents are about the product, not one merchant')

beforeAll(async () => {
  if (!(await databaseAvailable())) {
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before the test suite.')
  }
  harness = await setupTestDb('incident_findings')
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
})

const raiseGlobal = (reason: string) =>
  tripGlobalFlag(harness.db, system, {
    flag: 'global.pause_all',
    actor: 'auto',
    reason,
    trippedBy: 'auto',
  })

describe('recording what an operator found', () => {
  it('keeps the note against the incident after the switch is lowered', async () => {
    const flag = await raiseGlobal('judge fail rate over 60%')
    await addIncidentFinding(harness.db, system, {
      opsFlagId: flag!.id,
      author: 'alice',
      finding: 'a prompt change shipped without an eval run',
    })

    await resetGlobalFlag(harness.db, system, {
      flag: 'global.pause_all',
      resetBy: 'alice + bob',
    })

    // The switch is down...
    expect(await listActiveFlags(harness.db, system)).toEqual([])
    // ...and the incident, and the note on it, are still there to read.
    const closed = await findFlagById(harness.db, system, flag!.id)
    expect(closed?.resetAt).not.toBeNull()
    const findings = await listIncidentFindings(harness.db, system, flag!.id)
    expect(findings.map((f) => f.finding)).toEqual(['a prompt change shipped without an eval run'])
  })

  it('accepts a note written after the incident closed, because an investigation outlasts the trip', async () => {
    const flag = await raiseGlobal('vendor error rate')
    await resetGlobalFlag(harness.db, system, { flag: 'global.pause_all', resetBy: 'alice + bob' })

    await addIncidentFinding(harness.db, system, {
      opsFlagId: flag!.id,
      author: 'bob',
      finding: 'the vendor confirmed a regional outage three days later',
    })

    const findings = await listIncidentFindings(harness.db, system, flag!.id)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.author).toBe('bob')
  })

  it('reads several notes back in the order they were written', async () => {
    const flag = await raiseGlobal('judge fail rate over 60%')
    for (const finding of ['first look: nothing obvious', 'second look: a retry storm']) {
      await addIncidentFinding(harness.db, system, { opsFlagId: flag!.id, author: 'alice', finding })
    }
    const findings = await listIncidentFindings(harness.db, system, flag!.id)
    expect(findings.map((f) => f.finding)).toEqual([
      'first look: nothing obvious',
      'second look: a retry storm',
    ])
  })

  it('keeps each trip of the same switch a separate incident with its own notes', async () => {
    const first = await raiseGlobal('the first time')
    await addIncidentFinding(harness.db, system, {
      opsFlagId: first!.id,
      author: 'alice',
      finding: 'about the first one',
    })
    await resetGlobalFlag(harness.db, system, { flag: 'global.pause_all', resetBy: 'alice + bob' })

    const second = await raiseGlobal('and again a week later')
    expect(second!.id).not.toBe(first!.id)

    expect(await listIncidentFindings(harness.db, system, second!.id)).toEqual([])
    expect(await listIncidentFindings(harness.db, system, first!.id)).toHaveLength(1)
  })
})

describe('finding the incident to write against', () => {
  it('resolves a switch that is up now by its name', async () => {
    const flag = await raiseGlobal('judge fail rate over 60%')
    const found = await findActiveGlobalFlag(harness.db, system, 'global.pause_all')
    expect(found?.id).toBe(flag!.id)
  })

  it('finds nothing by name once the switch is down, so the id is the only way back to it', async () => {
    await raiseGlobal('judge fail rate over 60%')
    await resetGlobalFlag(harness.db, system, { flag: 'global.pause_all', resetBy: 'alice + bob' })
    expect(await findActiveGlobalFlag(harness.db, system, 'global.pause_all')).toBeUndefined()
  })

  it('lists closed incidents as well as open ones, newest first, with their notes', async () => {
    const account = await insertAccount(harness.pool, 'a@example.com')
    const scope = accountScope(account)
    const closed = await tripAccountFlag(harness.db, scope, {
      flag: 'account.pause_generation',
      actor: 'auto',
      reason: 'spend spike',
      trippedBy: 'auto',
    })
    await addIncidentFinding(harness.db, system, {
      opsFlagId: closed!.id,
      author: 'alice',
      finding: 'a bulk import, not a bug',
    })
    await resetAccountFlag(harness.db, scope, { flag: 'account.pause_generation', resetBy: 'alice' })
    const open = await tripAccountFlag(harness.db, scope, {
      flag: 'account.pause_publishing',
      actor: 'alice',
      reason: 'merchant asked',
      trippedBy: 'manual',
    })

    const recent = await listRecentFlags(harness.db, system, { accountId: account, limit: 10 })
    expect(recent.map((r) => r.id)).toEqual([open!.id, closed!.id])

    const notes = await listFindingsForFlags(
      harness.db,
      system,
      recent.map((r) => r.id),
    )
    expect(notes.get(closed!.id)?.map((f) => f.finding)).toEqual(['a bulk import, not a bug'])
    expect(notes.get(open!.id)).toBeUndefined()
  })

  it('scopes an account switch lookup to that account', async () => {
    const mine = await insertAccount(harness.pool, 'mine@example.com')
    const theirs = await insertAccount(harness.pool, 'theirs@example.com')
    await tripAccountFlag(harness.db, accountScope(mine), {
      flag: 'account.pause_generation',
      actor: 'auto',
      reason: 'spend spike',
      trippedBy: 'auto',
    })
    expect(
      await findActiveAccountFlag(harness.db, accountScope(theirs), 'account.pause_generation'),
    ).toBeUndefined()
  })
})
