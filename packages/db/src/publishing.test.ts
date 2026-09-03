import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { accountScope, systemScope } from './scope'
import { saveShopifyConnection } from './repositories/connections'
import { readAccountSettings } from './repositories/settings'
import {
  abandonPublishIntent,
  confirmPublishIntent,
  confirmedRemoteArticleId,
  findPublishIntent,
  hasPendingPublish,
  openPublishIntent,
  pendingPublishIntents,
  readPublishTarget,
  recordPublishGrant,
  setDeliveryMode,
  setShopifyPublishAs,
  setTargetBlog,
} from './repositories/publishing'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from './testing'

/**
 * Two behaviours, both of which are the database's rather than any caller's.
 *
 * Auto-publishing cannot be switched on for a store that has not granted
 * posting permission and named a blog — enforced in the `WHERE` clause, so it
 * holds whatever the caller believes.
 *
 * And a publication is claimed exactly once. The claim is what stops a worker
 * that died mid-publish, and its replacement, from both posting the same
 * article; two workers agreeing between themselves is precisely what a crash
 * makes impossible.
 */

let harness: TestDb
let accountId: string
let scope: ReturnType<typeof accountScope>

const READ_ONLY = ['read_products', 'read_content']
const WITH_WRITE = [...READ_ONLY, 'write_content']

beforeAll(async () => {
  if (!(await databaseAvailable())) {
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before the test suite.')
  }
  harness = await setupTestDb('publishing')
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
  accountId = await insertAccount(harness.pool, `publish-${Date.now()}@example.com`)
  scope = accountScope(accountId)
})

async function connect(scopes: readonly string[]): Promise<void> {
  await saveShopifyConnection(harness.db, scope, {
    shopHandle: 'acme',
    accessTokenCipher: 'cipher',
    grantedScopes: scopes,
  })
}

describe('the second grant and the blog it posts to', () => {
  it('records a publishing grant onto a connection that already exists', async () => {
    await connect(READ_ONLY)
    expect(
      await recordPublishGrant(harness.db, scope, {
        shopHandle: 'acme',
        accessTokenCipher: 'cipher-2',
        grantedScopes: WITH_WRITE,
      }),
    ).toBe(true)
    const target = await readPublishTarget(harness.db, scope)
    expect(target?.grantedScopes).toEqual(WITH_WRITE)
    expect(target?.accessTokenCipher).toBe('cipher-2')
  })

  it('creates no connection for a store that never installed us', async () => {
    expect(
      await recordPublishGrant(harness.db, scope, {
        shopHandle: 'acme',
        accessTokenCipher: 'cipher',
        grantedScopes: WITH_WRITE,
      }),
    ).toBe(false)
    expect(await readPublishTarget(harness.db, scope)).toBeUndefined()
  })

  it('refuses to record a target blog on a store that cannot post', async () => {
    await connect(READ_ONLY)
    expect(await setTargetBlog(harness.db, scope, { blogId: 'b1', blogHandle: 'news' })).toBe(false)
    expect((await readPublishTarget(harness.db, scope))?.targetBlogId).toBeNull()
  })

  it('records one on a store that can', async () => {
    await connect(WITH_WRITE)
    expect(await setTargetBlog(harness.db, scope, { blogId: 'b1', blogHandle: 'news' })).toBe(true)
    expect((await readPublishTarget(harness.db, scope))?.targetBlogId).toBe('b1')
  })
})

describe('auto-publish cannot be switched on without a blog to post to', () => {
  it('refuses a store with permission and no blog', async () => {
    await connect(WITH_WRITE)
    expect(await setDeliveryMode(harness.db, scope, 'auto')).toBe(false)
    expect((await readAccountSettings(harness.db, scope)).delivery).toBe('export')
  })

  it('refuses a store with a blog and no permission', async () => {
    await connect(WITH_WRITE)
    await setTargetBlog(harness.db, scope, { blogId: 'b1', blogHandle: 'news' })
    // The grant is withdrawn afterwards, which is what happens when a merchant
    // removes our permission in Shopify's admin: the blog stays named.
    await connect(READ_ONLY)
    await harness.pool.query('UPDATE shopify_conns SET target_blog_id = $1 WHERE account_id = $2', [
      'b1',
      accountId,
    ])
    expect(await setDeliveryMode(harness.db, scope, 'auto')).toBe(false)
    expect((await readAccountSettings(harness.db, scope)).delivery).toBe('export')
  })

  it('allows a store with both, and always allows switching back off', async () => {
    await connect(WITH_WRITE)
    await setTargetBlog(harness.db, scope, { blogId: 'b1', blogHandle: 'news' })
    expect(await setDeliveryMode(harness.db, scope, 'auto')).toBe(true)
    expect((await readAccountSettings(harness.db, scope)).delivery).toBe('auto')

    await connect(READ_ONLY)
    expect(await setDeliveryMode(harness.db, scope, 'export')).toBe(true)
    expect((await readAccountSettings(harness.db, scope)).delivery).toBe('export')
  })

  it('carries the live-or-draft choice through to what publishing reads', async () => {
    await connect(WITH_WRITE)
    expect((await readPublishTarget(harness.db, scope))?.publishAs).toBe('live')
    await setShopifyPublishAs(harness.db, scope, 'draft')
    expect((await readPublishTarget(harness.db, scope))?.publishAs).toBe('draft')
  })
})

describe('one publication, one claim', () => {
  const EXTERNAL = 'sortiva-11111111-1111-4111-8111-111111111111'

  it('lets one worker claim it and stops the second', async () => {
    const first = await openPublishIntent(harness.db, scope, {
      articleExternalId: EXTERNAL,
      revisionN: 0,
    })
    expect(first?.state).toBe('pending')

    const second = await openPublishIntent(harness.db, scope, {
      articleExternalId: EXTERNAL,
      revisionN: 0,
    })
    expect(second).toBeUndefined()
  })

  it('stops a second worker on another account too, because the claim is global', async () => {
    await openPublishIntent(harness.db, scope, { articleExternalId: EXTERNAL, revisionN: 0 })
    const other = accountScope(await insertAccount(harness.pool, `other-${Date.now()}@example.com`))
    expect(
      await openPublishIntent(harness.db, other, { articleExternalId: EXTERNAL, revisionN: 0 }),
    ).toBeUndefined()
  })

  it('confirms once, and tells the second confirmer it did nothing', async () => {
    await openPublishIntent(harness.db, scope, { articleExternalId: EXTERNAL, revisionN: 0 })
    expect(
      await confirmPublishIntent(harness.db, scope, {
        articleExternalId: EXTERNAL,
        shopifyArticleId: 'remote-1',
      }),
    ).toBe(true)
    expect(
      await confirmPublishIntent(harness.db, scope, {
        articleExternalId: EXTERNAL,
        shopifyArticleId: 'remote-2',
      }),
    ).toBe(false)
    expect(await confirmedRemoteArticleId(harness.db, scope, EXTERNAL)).toBe('remote-1')
  })

  it('names no remote article until one is confirmed', async () => {
    await openPublishIntent(harness.db, scope, { articleExternalId: EXTERNAL, revisionN: 0 })
    expect(await confirmedRemoteArticleId(harness.db, scope, EXTERNAL)).toBeUndefined()
  })

  it('gives the sweep only claims that were never confirmed, oldest first', async () => {
    await openPublishIntent(harness.db, scope, { articleExternalId: `${EXTERNAL}#r1`, revisionN: 1 })
    await openPublishIntent(harness.db, scope, { articleExternalId: EXTERNAL, revisionN: 0 })
    await confirmPublishIntent(harness.db, scope, {
      articleExternalId: EXTERNAL,
      shopifyArticleId: 'remote-1',
    })

    const pending = await pendingPublishIntents(
      harness.db,
      systemScope('the recovery sweep looks across every account'),
      new Date(Date.now() + 60_000),
    )
    expect(pending.map((row) => row.articleExternalId)).toEqual([`${EXTERNAL}#r1`])
  })

  it('leaves a claim younger than the cutoff alone', async () => {
    await openPublishIntent(harness.db, scope, { articleExternalId: EXTERNAL, revisionN: 0 })
    const pending = await pendingPublishIntents(
      harness.db,
      systemScope('the recovery sweep looks across every account'),
      new Date(Date.now() - 60_000),
    )
    expect(pending).toHaveLength(0)
  })

  it('reports an account with a publication in flight, and none once it is settled', async () => {
    expect(await hasPendingPublish(harness.db, scope)).toBe(false)
    await openPublishIntent(harness.db, scope, { articleExternalId: EXTERNAL, revisionN: 0 })
    expect(await hasPendingPublish(harness.db, scope)).toBe(true)
    await abandonPublishIntent(harness.db, scope, EXTERNAL)
    expect(await hasPendingPublish(harness.db, scope)).toBe(false)
    expect((await findPublishIntent(harness.db, scope, EXTERNAL))?.state).toBe('abandoned')
  })
})
