import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  StubNotificationEmitter,
  type DomainState,
  type StoreConnection,
  type StorePage,
  type StorePageFetcher,
} from '@sortiva/core'
import { MockShopifyOAuthClient, ShopifyTokenInvalid } from '@sortiva/providers'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { createRun } from '../runtime/steps'
import { dispatchIngestion } from './dispatch'
import type { ConnectionStore, IngestionDeps, ShopReader, ShopSnapshot } from './deps'
import { readDetectedShopHandle } from './steps'

/**
 * A merchant's onboarding from the moment they claim a domain, against a real
 * database and an in-memory Shopify.
 *
 * The point of driving it end to end is that the interesting behaviour is all in
 * the seams: that the dispatcher works from the rows the claim wrote rather than
 * making its own, that it stops at the connect screen instead of failing, and
 * that a rejected token routes the store to the reconnect screen rather than
 * into a queue nobody can drain.
 */

let harness: TestDb
let accountId: string

class FakeFetcher implements StorePageFetcher {
  readonly answers = new Map<string, StorePage | Error>()

  serves(url: string, page: Partial<StorePage>): this {
    this.answers.set(url, {
      finalUrl: url,
      status: 200,
      contentType: 'text/html',
      body: '',
      bytes: 0,
      chain: [url],
      headers: {},
      ...page,
    })
    return this
  }

  refuses(url: string): this {
    this.answers.set(url, new Error('not found'))
    return this
  }

  async fetch(request: { url: string }): Promise<StorePage> {
    const answer = this.answers.get(request.url)
    if (answer === undefined) throw new Error(`unexpected fetch: ${request.url}`)
    if (answer instanceof Error) throw answer
    return answer
  }
}

/** An in-memory connection store, so the test can grant and revoke at will. */
class FakeConnections implements ConnectionStore {
  private connection: StoreConnection | undefined
  private token: string | undefined

  grant(input: { accountId: string; shopHandle: string; token: string; scopes: string[] }): void {
    this.connection = {
      accountId: input.accountId,
      shopHandle: input.shopHandle,
      grantedScopes: input.scopes,
      connectedAt: new Date('2026-09-01T09:00:00Z'),
      invalidatedAt: null,
    }
    this.token = input.token
  }

  async read(): Promise<StoreConnection | undefined> {
    return this.connection
  }

  async readToken(): Promise<string | undefined> {
    return this.token
  }

  async markInvalid(_accountId: string, at: Date): Promise<Date> {
    if (this.connection && this.connection.invalidatedAt === null) {
      this.connection = { ...this.connection, invalidatedAt: at }
    }
    return this.connection?.invalidatedAt ?? at
  }
}

/**
 * A store with nothing in it. Enough for the catalogue sync to run to the end,
 * which is what these tests need now that the step has a handler; what the sync
 * does with a store that has products is `catalog.test.ts`.
 */
class EmptyStore {
  async getPage<T>(
    _auth: { shop: string; accessToken: string },
    path: string,
  ): Promise<{ body: T; nextPageInfo: string | undefined }> {
    const key = path.startsWith('orders.json') ? 'orders' : 'products'
    return { body: { [key]: [] } as T, nextPageInfo: undefined }
  }
}

class FakeShopReader implements ShopReader {
  private rejecting = false

  rejectsToken(): void {
    this.rejecting = true
  }

  async getShop(input: { shop: string }): Promise<ShopSnapshot> {
    if (this.rejecting) throw new ShopifyTokenInvalid(input.shop, 401)
    return {
      id: 42,
      name: 'Acme Candles',
      myshopifyDomain: `${input.shop}.myshopify.com`,
      ianaTimezone: 'Europe/London',
      countryCode: 'GB',
      currency: 'GBP',
    }
  }
}

interface World {
  deps: IngestionDeps
  fetcher: FakeFetcher
  connections: FakeConnections
  shop: FakeShopReader
  notifications: StubNotificationEmitter
  domainStates: DomainState[]
}

function world(domain: string): World {
  const fetcher = new FakeFetcher()
  const connections = new FakeConnections()
  const shop = new FakeShopReader()
  const notifications = new StubNotificationEmitter()
  const domainStates: DomainState[] = []

  const deps: IngestionDeps = {
    db: harness.db,
    pool: harness.pool,
    fetcher,
    shopify: new MockShopifyOAuthClient(),
    shop,
    admin: new EmptyStore(),
    connections,
    notifications,
    domains: {
      async findAccountByShopHandle() {
        return accountId
      },
      async setPlatform(id, platform) {
        await harness.pool.query('UPDATE domains SET platform = $1 WHERE account_id = $2', [
          platform,
          id,
        ])
      },
      async transition(id, from, to) {
        const { rows } = await harness.pool.query<{ state: DomainState }>(
          `UPDATE domains SET state = $1, updated_at = now()
             WHERE account_id = $2 AND state = ANY($3::domain_state[]) RETURNING state`,
          [to, id, from],
        )
        if (rows[0]) domainStates.push(rows[0].state)
        return rows[0]?.state
      },
      async read(id) {
        const { rows } = await harness.pool.query<{ state: DomainState }>(
          'SELECT state FROM domains WHERE account_id = $1',
          [id],
        )
        return rows[0]?.state
      },
      async readNormalized() {
        return domain
      },
    },
  }

  return { deps, fetcher, connections, shop, notifications, domainStates }
}

async function domainState(): Promise<string> {
  const { rows } = await harness.pool.query<{ state: string }>(
    'SELECT state FROM domains WHERE account_id = $1',
    [accountId],
  )
  return rows[0]!.state
}

async function stepStates(jobId: string): Promise<Record<string, string>> {
  const { rows } = await harness.pool.query<{ step: string; state: string }>(
    'SELECT step, state FROM job_steps WHERE job_id = $1',
    [jobId],
  )
  return Object.fromEntries(rows.map((r) => [r.step, r.state]))
}

beforeAll(async () => {
  if (!(await databaseAvailable())) {
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before the test suite.')
  }
  harness = await setupTestDb('ingestion_dispatch')
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
  accountId = await insertAccount(harness.pool, `merchant-${Date.now()}@example.com`)
  await harness.pool.query('INSERT INTO domains (account_id, domain_normalized) VALUES ($1,$2)', [
    accountId,
    'acme.example',
  ])
})

describe('a Shopify store being onboarded', () => {
  it('runs the steps the claim wrote and stops at the connect screen', async () => {
    const { jobId } = await createRun(harness.db, accountId, 'claim:acme.example')
    const w = world('acme.example')
    w.fetcher.serves('https://acme.example/', {
      headers: { 'x-shopid': '9' },
      body: '<script>window.Shopify = {}; "acme-candles.myshopify.com"</script>',
    })

    const result = await dispatchIngestion(w.deps, { accountId })

    expect(result?.jobId).toBe(jobId)
    expect(result?.executed).toEqual(['detect'])
    expect(result?.stoppedBecause).toBe('waiting')
    expect(result?.stoppedAt).toBe('oauth_wait')
    expect(await domainState()).toBe('awaiting_shopify_auth')
    expect(await readDetectedShopHandle(harness.db, accountId)).toBe('acme-candles')
  })

  it('never starts a second onboarding beside the one the claim wrote', async () => {
    await createRun(harness.db, accountId, 'claim:acme.example')
    const w = world('acme.example')
    w.fetcher.serves('https://acme.example/', { headers: { 'x-shopid': '9' }, body: 'acme.myshopify.com' })

    await dispatchIngestion(w.deps, { accountId })
    await dispatchIngestion(w.deps, { accountId })

    const { rows } = await harness.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM ingestion_jobs WHERE account_id = $1',
      [accountId],
    )
    expect(rows[0]!.n).toBe('1')
  })

  it('continues the moment permission is granted, and does not redo the first step', async () => {
    const { jobId } = await createRun(harness.db, accountId, 'claim:acme.example')
    const w = world('acme.example')
    w.fetcher.serves('https://acme.example/', { headers: { 'x-shopid': '9' }, body: 'acme.myshopify.com' })

    await dispatchIngestion(w.deps, { accountId })
    w.connections.grant({
      accountId,
      shopHandle: 'acme',
      token: 'shpat_x',
      scopes: ['read_products', 'read_orders', 'read_content', 'read_locales'],
    })

    const resumed = await dispatchIngestion(w.deps, { accountId })

    // Permission granted, so the run carries straight on into reading the
    // store. Distillation is the next step and belongs to a later card, so the
    // run correctly stops there.
    expect(resumed?.executed).toEqual(['oauth_wait', 'catalog_sync'])
    expect(resumed?.stoppedBecause).toBe('no_handler')
    expect(resumed?.stoppedAt).toBe('distill')
    expect(await domainState()).toBe('ingesting')

    const states = await stepStates(jobId)
    expect(states['detect']).toBe('succeeded')
    expect(states['oauth_wait']).toBe('succeeded')
    expect(states['catalog_sync']).toBe('succeeded')
    expect(states['distill']).toBe('pending')
  })

  it('recognises work already done rather than paying for it twice', async () => {
    await createRun(harness.db, accountId, 'claim:acme.example')
    const w = world('acme.example')
    let fetches = 0
    const counting: StorePageFetcher = {
      async fetch(request) {
        fetches += 1
        return w.fetcher.fetch(request)
      },
    }
    w.fetcher.serves('https://acme.example/', { headers: { 'x-shopid': '9' }, body: 'acme.myshopify.com' })

    await dispatchIngestion({ ...w.deps, fetcher: counting }, { accountId })
    // Re-running the same step from scratch: the ledger answers from what the
    // first run recorded, so the store is not fetched a second time.
    await harness.pool.query(
      `UPDATE job_steps SET state = 'pending' WHERE step = 'detect' AND job_id IN
         (SELECT id FROM ingestion_jobs WHERE account_id = $1)`,
      [accountId],
    )
    await dispatchIngestion({ ...w.deps, fetcher: counting }, { accountId })

    expect(fetches).toBe(1)
  })
})

describe('a site that is not a Shopify store', () => {
  it('is parked, keeps its domain, and stops showing steps that will never run', async () => {
    const { jobId } = await createRun(harness.db, accountId, 'claim:acme.example')
    const w = world('acme.example')
    w.fetcher.serves('https://acme.example/', { body: '<html>wp-content</html>' })
    w.fetcher.refuses('https://acme.example/products.json?limit=1')

    const result = await dispatchIngestion(w.deps, { accountId })

    expect(result?.stoppedBecause).toBe('parked_unsupported')
    expect(await domainState()).toBe('unsupported')

    const states = await stepStates(jobId)
    expect(states['detect']).toBe('succeeded')
    expect(states['oauth_wait']).toBe('skipped')
    expect(states['awaiting_confirmation']).toBe('skipped')

    // The claim itself is untouched: they keep the domain.
    const { rows } = await harness.pool.query<{ domain_normalized: string; platform: string }>(
      'SELECT domain_normalized, platform FROM domains WHERE account_id = $1',
      [accountId],
    )
    expect(rows[0]).toMatchObject({ domain_normalized: 'acme.example', platform: 'custom_unsupported' })
  })
})

describe('when Shopify rejects the token we hold', () => {
  it('sends the merchant to the reconnect screen instead of the dead-letter queue', async () => {
    const { jobId } = await createRun(harness.db, accountId, 'claim:acme.example')
    const w = world('acme.example')
    w.fetcher.serves('https://acme.example/', { headers: { 'x-shopid': '9' }, body: 'acme.myshopify.com' })
    await dispatchIngestion(w.deps, { accountId })

    w.connections.grant({
      accountId,
      shopHandle: 'acme',
      token: 'stale',
      scopes: ['read_products'],
    })
    w.shop.rejectsToken()

    const result = await dispatchIngestion(w.deps, { accountId })

    expect(result?.stoppedBecause).toBe('awaiting_reauth')
    expect(await domainState()).toBe('awaiting_shopify_auth')

    // Nothing landed in the dead-letter queue: no operator can fix this, only
    // the merchant can.
    const { rows } = await harness.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM job_dlq WHERE job_id = $1',
      [jobId],
    )
    expect(rows[0]!.n).toBe('0')

    expect(w.notifications.emitted.map((e) => e.type)).toEqual(['connection_lost_shopify'])
  })

  it('tells the merchant once, however many times the worker runs', async () => {
    await createRun(harness.db, accountId, 'claim:acme.example')
    const w = world('acme.example')
    w.fetcher.serves('https://acme.example/', { headers: { 'x-shopid': '9' }, body: 'acme.myshopify.com' })
    await dispatchIngestion(w.deps, { accountId })
    w.connections.grant({ accountId, shopHandle: 'acme', token: 'stale', scopes: ['read_products'] })
    w.shop.rejectsToken()

    await dispatchIngestion(w.deps, { accountId })
    await dispatchIngestion(w.deps, { accountId })

    expect(w.notifications.emitted).toHaveLength(1)
  })
})

describe('an account with nothing to dispatch', () => {
  it('does nothing rather than inventing a run', async () => {
    const w = world('acme.example')
    expect(await dispatchIngestion(w.deps, { accountId })).toBeUndefined()
  })
})
