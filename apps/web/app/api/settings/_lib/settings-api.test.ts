import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { settingsSchema } from '@sortiva/core'
import { accountScope, makeSettingsStore, setTargetBlog } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { withAccount } from '../../auth/_lib/session'
import { makeReadSettingsHandler, makeUpdateSettingsHandler } from './handlers'

/**
 * The Settings screens' server, driven end to end: the real session wrapper,
 * the real handlers, the real repositories, a real Postgres.
 *
 * This card exists because both screens called an address nobody had built and
 * nothing went red — the loader turns any failure into "no data", so a 404
 * renders as a store whose settings happen to equal the defaults. Mocking the
 * request here would reproduce that exactly.
 */

const available = await databaseAvailable()

describe('the route exists where the screens call it', () => {
  // Not skipped without Postgres: a missing route file is not a database
  // problem, and this is the assertion that would have caught the original
  // defect on its own.
  it('serves GET and PATCH /api/settings', async () => {
    const route = await import('../route')
    expect(typeof route.GET).toBe('function')
    expect(typeof route.PATCH).toBe('function')
    expect(route.dynamic).toBe('force-dynamic')
  })
})

describe.skipIf(!available)('reading and changing a store’s settings', () => {
  let harness: TestDb
  let mine: string
  let theirs: string

  beforeAll(async () => {
    harness = await setupTestDb('web_settings_api')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    mine = await insertAccount(harness.pool, 'mine@example.com')
    theirs = await insertAccount(harness.pool, 'theirs@example.com')
  })

  const deps = () => ({ store: makeSettingsStore({ database: harness.db }) })

  const read = (accountId: string | null) =>
    withAccount(
      makeReadSettingsHandler(deps()),
      async () => accountId,
    )(new Request('http://localhost/api/settings'), undefined)

  const patch = (accountId: string | null, body: unknown) =>
    withAccount(
      makeUpdateSettingsHandler(deps()),
      async () => accountId,
    )(
      new Request('http://localhost/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      undefined,
    )

  /** Gives the store a write grant and a resolved blog — what auto-publish needs. */
  async function readyToPublish(accountId: string) {
    await harness.pool.query(
      `insert into shopify_conns (account_id, shop_handle, access_token, granted_scopes)
       values ($1, 'acme-test', 'placeholder', array['read_products','write_content'])`,
      [accountId],
    )
    await setTargetBlog(harness.db, accountScope(accountId), {
      blogId: 'gid://blog/1',
      blogHandle: 'news',
    })
  }

  it('answers every setting the contract promises, defaults and all', async () => {
    const response = await read(mine)
    expect(response.status).toBe(200)
    // Parsed against the frozen schema rather than eyeballed: a field the
    // contract declares and this route omits fails here.
    const body = settingsSchema.parse(await response.json())
    expect(body.delivery).toBe('export')
    expect(body.publishHour).toBe(9)
    // The matrix default a merchant who has never opened Settings gets, which
    // is not the column default — the monthly summary is on unless turned off.
    expect(body.emailDigestFrequency).toBe('weekly')
  })

  it('saves what changed and answers with what is now true', async () => {
    const response = await patch(mine, { publishHour: 17, timezone: 'Europe/Copenhagen', draftReview: true })
    expect(response.status).toBe(200)
    const body = settingsSchema.parse(await response.json())
    expect(body).toMatchObject({ publishHour: 17, timezone: 'Europe/Copenhagen', draftReview: true })
    // Read back through a second request, so this proves storage rather than echo.
    expect(settingsSchema.parse(await (await read(mine)).json()).publishHour).toBe(17)
  })

  it('leaves alone what the merchant did not send', async () => {
    await patch(mine, { publishHour: 6, autoRepair: false })
    await patch(mine, { timezone: 'Europe/Oslo' })

    const body = settingsSchema.parse(await (await read(mine)).json())
    expect(body).toMatchObject({ publishHour: 6, autoRepair: false, timezone: 'Europe/Oslo' })
  })

  it('refuses auto-publish with no permission to post', async () => {
    const response = await patch(mine, { delivery: 'auto' })
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'write_scope_required',
    )
    expect(settingsSchema.parse(await (await read(mine)).json()).delivery).toBe('export')
  })

  it('refuses auto-publish with permission but no blog to post to', async () => {
    await harness.pool.query(
      `insert into shopify_conns (account_id, shop_handle, access_token, granted_scopes)
       values ($1, 'acme-test', 'placeholder', array['read_products','write_content'])`,
      [mine],
    )
    const response = await patch(mine, { delivery: 'auto' })
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'target_blog_unresolved',
    )
  })

  it('allows auto-publish once both consents are in place', async () => {
    await readyToPublish(mine)
    const response = await patch(mine, { delivery: 'auto' })
    expect(response.status).toBe(200)
    expect(settingsSchema.parse(await response.json()).delivery).toBe('auto')
  })

  it('never holds up a merchant switching auto-publish off', async () => {
    await readyToPublish(mine)
    await patch(mine, { delivery: 'auto' })
    // The grant goes away underneath them — the state that blocks switching on.
    await harness.pool.query('update shopify_conns set granted_scopes = array[$2] where account_id = $1', [
      mine,
      'read_products',
    ])

    const response = await patch(mine, { delivery: 'export' })
    expect(response.status).toBe(200)
    expect(settingsSchema.parse(await response.json()).delivery).toBe('export')
  })

  it('writes both email preferences even when the merchant changed one', async () => {
    await patch(mine, { emailDigestFrequency: 'weekly' })
    await patch(mine, { emailArticlePublished: true })

    const body = settingsSchema.parse(await (await read(mine)).json())
    // The second write must not have taken the first column's default back.
    expect(body).toMatchObject({ emailDigestFrequency: 'weekly', emailArticlePublished: true })
  })

  it('refuses a value outside the contract rather than storing it', async () => {
    const response = await patch(mine, { publishHour: 25 })
    expect(response.status).toBe(422)
    expect(settingsSchema.parse(await (await read(mine)).json()).publishHour).toBe(9)
  })

  it('cannot be reached without a session, and never crosses accounts', async () => {
    expect((await read(null)).status).toBe(401)
    await patch(mine, { publishHour: 21 })
    expect(settingsSchema.parse(await (await read(theirs)).json()).publishHour).toBe(9)
  })
})
