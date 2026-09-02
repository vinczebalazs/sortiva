import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { systemScope } from './scope'
import { createVerificationToken, useVerificationToken } from './repositories/verificationTokens'
import { databaseAvailable, setupTestDb, truncateAll, type TestDb } from './testing'

/**
 * Email sign-in links, against a real Postgres — because the property that
 * matters is a database property. "Single use" is not a flag we check, it is
 * `DELETE … RETURNING` handing the row to exactly one caller, and only the real
 * engine can be asked whether that holds when two requests arrive together.
 */

let harness: TestDb

const scope = systemScope('test: a sign-in link exists before the account does')

beforeAll(async () => {
  if (!(await databaseAvailable())) {
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before the test suite.')
  }
  harness = await setupTestDb('verification_tokens')
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
})

const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000)

describe('email sign-in links', () => {
  it('hands back the link it stored', async () => {
    await createVerificationToken(harness.db, scope, {
      identifier: 'founder@example.com',
      token: 'hash-1',
      expires: inAnHour(),
    })

    const spent = await useVerificationToken(harness.db, scope, {
      identifier: 'founder@example.com',
      token: 'hash-1',
    })

    expect(spent?.identifier).toBe('founder@example.com')
  })

  it('spends a link exactly once', async () => {
    await createVerificationToken(harness.db, scope, {
      identifier: 'founder@example.com',
      token: 'hash-1',
      expires: inAnHour(),
    })

    const first = await useVerificationToken(harness.db, scope, {
      identifier: 'founder@example.com',
      token: 'hash-1',
    })
    const second = await useVerificationToken(harness.db, scope, {
      identifier: 'founder@example.com',
      token: 'hash-1',
    })

    expect(first).toBeDefined()
    expect(second).toBeUndefined()
  })

  it('gives the row to one of two requests racing on the same link', async () => {
    await createVerificationToken(harness.db, scope, {
      identifier: 'founder@example.com',
      token: 'hash-1',
      expires: inAnHour(),
    })

    // A double-clicked button, or a mail scanner prefetching the URL just before
    // the human clicks it. Read-then-delete would sign both of them in.
    const [a, b] = await Promise.all([
      useVerificationToken(harness.db, scope, {
        identifier: 'founder@example.com',
        token: 'hash-1',
      }),
      useVerificationToken(harness.db, scope, {
        identifier: 'founder@example.com',
        token: 'hash-1',
      }),
    ])

    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it('will not spend a link on an address it was not sent to', async () => {
    await createVerificationToken(harness.db, scope, {
      identifier: 'founder@example.com',
      token: 'hash-1',
      expires: inAnHour(),
    })

    const spent = await useVerificationToken(harness.db, scope, {
      identifier: 'attacker@example.com',
      token: 'hash-1',
    })

    expect(spent).toBeUndefined()
  })

  it('returns nothing for a link that was never issued', async () => {
    expect(
      await useVerificationToken(harness.db, scope, {
        identifier: 'founder@example.com',
        token: 'never-issued',
      }),
    ).toBeUndefined()
  })

  it('keeps an expired row until it is spent, so the caller can say it expired', async () => {
    await createVerificationToken(harness.db, scope, {
      identifier: 'founder@example.com',
      token: 'hash-1',
      expires: new Date(Date.now() - 1000),
    })

    const spent = await useVerificationToken(harness.db, scope, {
      identifier: 'founder@example.com',
      token: 'hash-1',
    })

    expect(spent?.expires.valueOf()).toBeLessThan(Date.now())
  })
})
