import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { accountScope, systemScope } from './scope'
import {
  clearAccountGrants,
  loadAccountLifecycle,
  markAccountDeleted,
  purgePreviewCacheRow,
} from './repositories/lifecycle'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from './testing'

/**
 * The database side of ending an account.
 *
 * It lives here rather than beside the route because of one assertion: the
 * logged-out preview's cached summary is keyed by domain rather than by
 * account, so no cascade reaches it and account deletion has to name it. Naming
 * that table is only permitted inside this package and inside the preview
 * itself — everywhere else, a mention of it would be a read path into
 * deliberately disposable data.
 */

const AT = new Date('2026-09-02T12:00:00.000Z')
const RELEASE_AT = new Date('2026-09-09T12:00:00.000Z')
const system = systemScope('the preview cache precedes any account')

let harness: TestDb

beforeAll(async () => {
  if (!(await databaseAvailable())) {
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before the test suite.')
  }
  harness = await setupTestDb('db_lifecycle')
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
})

async function connectedAccount(): Promise<string> {
  const accountId = await insertAccount(harness.pool, 'ending@example.com')
  await harness.pool.query(
    "insert into domains (account_id, domain_normalized, state) values ($1, 'ending.example', 'ready_for_planning')",
    [accountId],
  )
  await harness.pool.query(
    "insert into shopify_conns (account_id, shop_handle, access_token, granted_scopes) values ($1, 'ending', 'shpat_cipher', ARRAY['read_products'])",
    [accountId],
  )
  await harness.pool.query(
    "insert into gsc_conns (account_id, property, tokens) values ($1, 'sc-domain:ending.example', 'gsc_cipher')",
    [accountId],
  )
  return accountId
}

describe('recording a deletion', () => {
  it('stamps it, dates the domain release, and marks both connections dead', async () => {
    const accountId = await connectedAccount()

    expect(await markAccountDeleted(harness.db, accountScope(accountId), {
      at: AT,
      domainReleaseAt: RELEASE_AT,
    })).toBe(true)

    const { rows } = await harness.pool.query<{
      deleted_at: Date
      release_after: Date
      shop_dead: Date | null
      gsc_dead: Date | null
    }>(
      `select a.deleted_at, d.release_after, s.invalidated_at as shop_dead, g.invalidated_at as gsc_dead
         from accounts a
         join domains d on d.account_id = a.id
         join shopify_conns s on s.account_id = a.id
         join gsc_conns g on g.account_id = a.id
        where a.id = $1`,
      [accountId],
    )
    expect(rows[0]!.deleted_at).toEqual(AT)
    expect(rows[0]!.release_after).toEqual(RELEASE_AT)
    expect(rows[0]!.shop_dead).not.toBeNull()
    expect(rows[0]!.gsc_dead).not.toBeNull()
  })

  it('keeps the tokens until the vendors have been told', async () => {
    // The vendor half runs as a job and re-reads them: a queue payload is a row
    // in a table, and a credential does not belong in one.
    const accountId = await connectedAccount()
    await markAccountDeleted(harness.db, accountScope(accountId), {
      at: AT,
      domainReleaseAt: RELEASE_AT,
    })

    const record = await loadAccountLifecycle(harness.db, accountScope(accountId))
    expect(record?.shopifyTokenCipher).toBe('shpat_cipher')
    expect(record?.gscTokensCipher).toBe('gsc_cipher')

    await clearAccountGrants(harness.db, accountScope(accountId))
    const after = await loadAccountLifecycle(harness.db, accountScope(accountId))
    expect(after?.shopifyTokenCipher).toBeNull()
    expect(after?.gscTokensCipher).toBeNull()
  })

  it('stands down when the account is already deleted', async () => {
    const accountId = await connectedAccount()
    await markAccountDeleted(harness.db, accountScope(accountId), {
      at: AT,
      domainReleaseAt: RELEASE_AT,
    })
    expect(await markAccountDeleted(harness.db, accountScope(accountId), {
      at: new Date('2026-09-03T00:00:00.000Z'),
      domainReleaseAt: new Date('2026-09-10T00:00:00.000Z'),
    })).toBe(false)

    const { rows } = await harness.pool.query<{ deleted_at: Date }>(
      'select deleted_at from accounts where id = $1',
      [accountId],
    )
    expect(rows[0]!.deleted_at, 'the first deletion’s moment stands').toEqual(AT)
  })
})

describe('the preview row, which no cascade reaches', () => {
  it('is deleted by domain, because that is the only thing it is keyed by', async () => {
    await harness.pool.query(
      `insert into preview_cache (domain_normalized, summary, expires_at)
       values ('ending.example', '{}'::jsonb, now() + interval '1 day'),
              ('other.example', '{}'::jsonb, now() + interval '1 day')`,
    )

    await purgePreviewCacheRow(harness.db, system, 'ending.example')

    const { rows } = await harness.pool.query<{ domain_normalized: string }>(
      'select domain_normalized from preview_cache',
    )
    expect(rows.map((r) => r.domain_normalized)).toEqual(['other.example'])
  })
})
