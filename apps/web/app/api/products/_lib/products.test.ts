import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createLogger, okSchema, type PosthogCapture } from '@sortiva/core'
import { accountScope, makeFamilyStore, reconcileFamilies } from '@sortiva/db'
import { databaseAvailable, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { withAccount } from '../../auth/_lib/session'
import { makeReportGroupingHandler } from './handlers'

/**
 * "You've grouped these wrong", driven end to end: the real session wrapper,
 * the real handler, the real repository, a real Postgres.
 *
 * Two properties matter more than the happy path. **A family belonging to
 * another merchant is not found**, so the route cannot be used to learn that an
 * id exists. And **the merchant's own words go to our record and not to the
 * analytics vendor**, which is invariant 26 and is asserted on the bytes rather
 * than on the intention.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('reporting a wrong grouping', () => {
  let harness: TestDb
  let mine: string
  let theirs: string
  let myFamilyId: string
  let theirFamilyId: string

  let logged: string[]
  let captured: { event: string; properties?: Record<string, unknown> }[]

  beforeAll(async () => {
    harness = await setupTestDb('web_products')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    const { rows } = await harness.pool.query<{ id: string; email: string }>(
      "INSERT INTO accounts (email) VALUES ('mine@example.com'), ('theirs@example.com') RETURNING id, email",
    )
    mine = rows.find((row) => row.email === 'mine@example.com')!.id
    theirs = rows.find((row) => row.email === 'theirs@example.com')!.id

    for (const accountId of [mine, theirs]) {
      await reconcileFamilies(
        harness.db,
        accountScope(accountId),
        [
          {
            name: 'Trail Running Shoes',
            memberProductIds: [],
            differentiationAxes: ['terrain', 'drop', 'width'],
            mergedFacts: {},
            groupingSource: 'collection',
            confidence: 'high',
          },
        ],
        new Map(),
      )
    }

    const families = await harness.pool.query<{ id: string; account_id: string }>(
      'SELECT id, account_id FROM product_families',
    )
    myFamilyId = families.rows.find((row) => row.account_id === mine)!.id
    theirFamilyId = families.rows.find((row) => row.account_id === theirs)!.id

    logged = []
    captured = []
  })

  const capture: Pick<PosthogCapture, 'capture'> = {
    capture(event) {
      captured.push({
        event: event.event,
        ...(event.properties ? { properties: event.properties } : {}),
      })
    },
  }

  const route = (accountId: string | null) =>
    withAccount(
      makeReportGroupingHandler({
        families: makeFamilyStore({ database: harness.db }),
        log: createLogger({ sink: (line) => logged.push(line) }),
        capture,
      }),
      async () => accountId,
    )

  const post = (accountId: string | null, body: unknown) =>
    route(accountId)(
      new Request('http://localhost/api/products/families/report', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      undefined,
    )

  it('accepts a report and answers with the contract\'s ok', async () => {
    const response = await post(mine, {
      familyId: myFamilyId,
      reason: 'The Trailhead 4 is a road shoe, not a trail shoe.',
    })

    expect(response.status).toBe(200)
    expect(okSchema.parse(await response.json())).toEqual({ ok: true })
  })

  it("keeps the merchant's words and sends only ids and counts to analytics", async () => {
    await post(mine, { familyId: myFamilyId, reason: 'The Trailhead 4 is a road shoe.' })

    // Our own record has what they typed.
    expect(logged.join('\n')).toContain('The Trailhead 4 is a road shoe.')

    // The analytics event does not, and carries the three facts that make the
    // reports useful in aggregate.
    const event = captured.find((entry) => entry.event === 'family_grouping_reported')
    expect(event).toBeDefined()
    expect(event!.properties).toEqual({
      family_id: myFamilyId,
      member_count: 0,
      grouping_source: 'collection',
    })
    expect(JSON.stringify(event)).not.toContain('road shoe')
  })

  it("answers not-found for another merchant's family, rather than confirming it exists", async () => {
    const response = await post(mine, { familyId: theirFamilyId, reason: 'wrong' })
    expect(response.status).toBe(404)
    expect(captured).toHaveLength(0)
  })

  it('refuses a report that names no reason', async () => {
    const response = await post(mine, { familyId: myFamilyId, reason: '' })
    expect(response.status).toBe(400)
  })

  it('refuses an unsigned-in caller before it reads anything', async () => {
    const response = await post(null, { familyId: myFamilyId, reason: 'wrong' })
    expect(response.status).toBe(401)
    expect(logged).toHaveLength(0)
  })
})
