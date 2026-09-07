import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  clearRulesOverride,
  listRulesOverrides,
  readRulesOverridesForAccount,
  setRulesOverride,
} from './rules'
import { accountScope, systemScope } from '../scope'
import type { Db } from '../client'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '../testing'

/**
 * `rules_overrides` against a real Postgres. Three of the four columns that
 * identify a row are nullable, which is where the mistakes live: a null never
 * equals anything, so plain `=` would make a global override impossible to
 * replace or to clear, and the operator would be told the clear succeeded.
 */

const available = await databaseAvailable()
const DEMAND_FLOOR = 'gates.demand_floor.monthly_search_volume_min'
const system = systemScope('rules_overrides holds rows that belong to every store')

describe.skipIf(!available)('rules_overrides', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string
  let otherAccountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('rules_overrides_repo')
    db = ctx.db as unknown as Db
  }, 60_000)

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'store@example.com')
    otherAccountId = await insertAccount(ctx.pool, 'other@example.com')
  })

  it('gives a store its own rows and the ones aimed at nobody, and never another store\'s', async () => {
    await setRulesOverride(db, system, { accountId, key: DEMAND_FLOOR, value: 10, updatedBy: 'ops' })
    await setRulesOverride(db, system, {
      accountId: otherAccountId,
      key: DEMAND_FLOOR,
      value: 20,
      updatedBy: 'ops',
    })
    await setRulesOverride(db, system, { key: 'learning.refresh.cooldown_days', value: 5, updatedBy: 'ops' })

    const mine = await readRulesOverridesForAccount(db, accountScope(accountId))
    expect(mine.map((row) => [row.key, row.value, row.accountId])).toEqual([
      [DEMAND_FLOOR, 10, accountId],
      ['learning.refresh.cooldown_days', 5, null],
    ])
  })

  it('leaves a language row out until the store is read under that language', async () => {
    await setRulesOverride(db, system, { locale: 'da', key: DEMAND_FLOOR, value: 30, updatedBy: 'ops' })

    expect(await readRulesOverridesForAccount(db, accountScope(accountId))).toEqual([])
    const inDanish = await readRulesOverridesForAccount(db, accountScope(accountId), { locale: 'da' })
    expect(inDanish.map((row) => row.value)).toEqual([30])
    // Exact match: the table does not resolve a full tag through its subtag the
    // way the config file's locale layers do.
    expect(await readRulesOverridesForAccount(db, accountScope(accountId), { locale: 'da-DK' })).toEqual([])
  })

  it('keeps a page-type row away from a read that names no page type', async () => {
    await setRulesOverride(db, system, {
      pageType: 'collection',
      key: DEMAND_FLOOR,
      value: 40,
      updatedBy: 'ops',
    })
    expect(await readRulesOverridesForAccount(db, accountScope(accountId))).toEqual([])
    expect(
      await readRulesOverridesForAccount(db, accountScope(accountId), { pageType: 'collection' }),
    ).toHaveLength(1)
  })

  it('replaces rather than duplicates when the same threshold is set twice', async () => {
    await setRulesOverride(db, system, { accountId, key: DEMAND_FLOOR, value: 10, updatedBy: 'first' })
    await setRulesOverride(db, system, { accountId, key: DEMAND_FLOOR, value: 11, updatedBy: 'second' })

    const rows = await readRulesOverridesForAccount(db, accountScope(accountId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.value).toBe(11)
    expect(rows[0]?.updatedBy).toBe('second')
  })

  it('replaces a global row without touching the store-specific one of the same name', async () => {
    await setRulesOverride(db, system, { key: DEMAND_FLOOR, value: 1, updatedBy: 'ops' })
    await setRulesOverride(db, system, { accountId, key: DEMAND_FLOOR, value: 2, updatedBy: 'ops' })
    await setRulesOverride(db, system, { key: DEMAND_FLOOR, value: 3, updatedBy: 'ops' })

    const rows = await readRulesOverridesForAccount(db, accountScope(accountId))
    expect(rows.map((row) => [row.accountId, row.value]).sort()).toEqual(
      [
        [accountId, 2],
        [null, 3],
      ].sort(),
    )
  })

  it('clears exactly the row it names and says what it removed', async () => {
    await setRulesOverride(db, system, { key: DEMAND_FLOOR, value: 1, updatedBy: 'ops' })
    await setRulesOverride(db, system, { accountId, key: DEMAND_FLOOR, value: 2, updatedBy: 'ops' })

    const removed = await clearRulesOverride(db, system, { key: DEMAND_FLOOR })
    expect(removed).toHaveLength(1)
    expect(removed[0]?.accountId).toBeNull()
    expect(await readRulesOverridesForAccount(db, accountScope(accountId))).toHaveLength(1)

    expect(await clearRulesOverride(db, system, { key: DEMAND_FLOOR })).toEqual([])
  })

  it('lists everything for an operator, and narrows to one store on request', async () => {
    await setRulesOverride(db, system, { accountId, key: DEMAND_FLOOR, value: 1, updatedBy: 'ops' })
    await setRulesOverride(db, system, {
      accountId: otherAccountId,
      key: DEMAND_FLOOR,
      value: 2,
      updatedBy: 'ops',
    })
    await setRulesOverride(db, system, { locale: 'da', key: DEMAND_FLOOR, value: 3, updatedBy: 'ops' })

    expect(await listRulesOverrides(db, system)).toHaveLength(3)
    const narrowed = await listRulesOverrides(db, system, { accountId })
    expect(narrowed.map((row) => row.value).sort()).toEqual([1, 3])
  })

  it('takes the store\'s rows away with the store', async () => {
    await setRulesOverride(db, system, { accountId, key: DEMAND_FLOOR, value: 1, updatedBy: 'ops' })
    await ctx.pool.query('DELETE FROM accounts WHERE id = $1', [accountId])
    expect(await listRulesOverrides(db, system)).toEqual([])
  })
})
