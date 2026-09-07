import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createSession,
  deleteSession,
  deleteSessionsForAccount,
  findSessionWithAccount,
  touchSession,
  SESSION_LOOKUP_REASON,
} from './sessions'
import { accountScope, systemScope } from '../scope'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '../testing'

/**
 * Signed-in browsers, against a real Postgres.
 *
 * What is proved here is the storage half: the row is found by exactly the
 * string it was written under, ending it makes the lookup miss, ending an
 * account's sessions leaves everybody else's alone, and erasing the account
 * takes its sessions with it without anyone having to remember to. Where the
 * sign-in library chooses to end a session is proved separately, against the
 * library itself, in `apps/web/app/api/auth/_lib/sessionRevocation.test.ts`.
 */

const available = await databaseAvailable()
const lookup = systemScope(SESSION_LOOKUP_REASON)

describe.skipIf(!available)('sessions', () => {
  let ctx: TestDb
  let accountId: string
  let otherAccountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('sessions_repo')
  }, 60_000)

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'founder@example.com')
    otherAccountId = await insertAccount(ctx.pool, 'someone@example.com')
  })

  const inAMonth = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  it('finds a session, and the account it belongs to, in one read', async () => {
    await createSession(ctx.db, accountScope(accountId), {
      tokenDigest: 'digest-1',
      expires: inAMonth(),
    })

    const found = await findSessionWithAccount(ctx.db, lookup, 'digest-1')

    expect(found).toMatchObject({ accountId, email: 'founder@example.com' })
  })

  it('answers nothing for a string nobody signed in with', async () => {
    expect(await findSessionWithAccount(ctx.db, lookup, 'never-issued')).toBeUndefined()
  })

  it('stops finding a session once it has been ended', async () => {
    await createSession(ctx.db, accountScope(accountId), {
      tokenDigest: 'digest-1',
      expires: inAMonth(),
    })

    const ended = await deleteSession(ctx.db, lookup, 'digest-1')

    expect(ended?.accountId).toBe(accountId)
    expect(await findSessionWithAccount(ctx.db, lookup, 'digest-1')).toBeUndefined()
  })

  it('ends every session one account has, and none of anybody else\'s', async () => {
    for (const digest of ['a', 'b', 'c']) {
      await createSession(ctx.db, accountScope(accountId), {
        tokenDigest: digest,
        expires: inAMonth(),
      })
    }
    await createSession(ctx.db, accountScope(otherAccountId), {
      tokenDigest: 'theirs',
      expires: inAMonth(),
    })

    expect(await deleteSessionsForAccount(ctx.db, accountScope(accountId))).toBe(3)

    for (const digest of ['a', 'b', 'c']) {
      expect(await findSessionWithAccount(ctx.db, lookup, digest)).toBeUndefined()
    }
    expect(await findSessionWithAccount(ctx.db, lookup, 'theirs')).toMatchObject({
      accountId: otherAccountId,
    })
  })

  it('says how many were ended, so a caller can tell revoked from nothing to revoke', async () => {
    expect(await deleteSessionsForAccount(ctx.db, accountScope(accountId))).toBe(0)
  })

  it('takes the sessions with the account when the account is finally erased', async () => {
    await createSession(ctx.db, accountScope(accountId), {
      tokenDigest: 'digest-1',
      expires: inAMonth(),
    })

    await ctx.pool.query('delete from accounts where id = $1', [accountId])

    expect(await findSessionWithAccount(ctx.db, lookup, 'digest-1')).toBeUndefined()
  })

  it('can move a lapse date, though nothing configured today asks it to', async () => {
    const later = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)
    await createSession(ctx.db, accountScope(accountId), {
      tokenDigest: 'digest-1',
      expires: inAMonth(),
    })

    await touchSession(ctx.db, lookup, { tokenDigest: 'digest-1', expires: later })

    const found = await findSessionWithAccount(ctx.db, lookup, 'digest-1')
    expect(found?.expires.toISOString()).toBe(later.toISOString())
  })
})
