import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  StubNotificationEmitter,
  staticShopifyAuth,
  type DomainState,
  type ShopifyAuth,
  type ShopifyOrder,
  type ShopifyProduct,
  type StoreConnection,
  type StorePage,
  type StorePageFetcher,
} from '@sortiva/core'
import { MockShopifyOAuthClient, ShopifyTokenInvalid } from '@sortiva/providers'
import {
  TEST_DATABASE_URL,
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { MockLlmClient } from '@sortiva/llm'
import { MockSeoDataProvider } from '@sortiva/providers'
import { createRun } from '../runtime/steps'
import { clearTasks, taskList } from '../runtime/tasks'
import { TRUNCATE_QUEUE_SQL, installQueueSchema, type WorkerUtils } from '../runtime/testing'
import { dispatchIngestion, registerIngestionTasks, resetIngestionTaskRegistration } from './dispatch'
import { sweepStalledIngestionRuns } from './retry-sweep'
import type { ConnectionStore, IngestionDeps, ShopReader, ShopSnapshot } from './deps'
import { resumeAfterReconnect } from './resume'
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
let workerUtils: WorkerUtils
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
  /** What the store said about itself, once somebody asked it. */
  identity: { storefrontHost?: string; shopName?: string } | undefined

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

  async authFor(): Promise<ShopifyAuth | undefined> {
    if (!this.connection || this.connection.invalidatedAt !== null || !this.token) return undefined
    return staticShopifyAuth(this.connection.shopHandle, this.token)
  }

  async recordStoreIdentity(
    _accountId: string,
    identity: { storefrontHost?: string; shopName?: string },
  ): Promise<void> {
    this.identity = identity
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
  async listProducts(): Promise<{ items: readonly ShopifyProduct[]; next: string | undefined }> {
    return { items: [], next: undefined }
  }

  async listOrders(): Promise<{
    items: readonly ShopifyOrder[]
    next: string | undefined
    timeZone: string | null
  }> {
    return { items: [], next: undefined, timeZone: 'Europe/London' }
  }
}

class FakeShopReader implements ShopReader {
  private rejecting = false

  rejectsToken(): void {
    this.rejecting = true
  }

  /** The merchant reconnected: the store answers again. */
  acceptsToken(): void {
    this.rejecting = false
  }

  async getShop(auth: ShopifyAuth): Promise<ShopSnapshot> {
    if (this.rejecting) throw new ShopifyTokenInvalid(auth.shop, 401)
    return {
      id: '42',
      name: 'Acme Candles',
      myshopifyDomain: `${auth.shop}.myshopify.com`,
      primaryDomain: 'acme.example',
      ianaTimezone: 'Europe/London',
      countryCode: 'GB',
      currency: 'GBP',
      primaryLocale: 'en-GB',
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

  // The store here has no products, so distillation makes no model call — but
  // the step refuses to run without a client rather than writing empty fact
  // sheets, so the process's one wrapper is supplied exactly as it is in
  // production.
  const llm = new MockLlmClient()
  llm.setDefault('distill', () => {
    throw new Error('an empty store has nothing to distil')
  })
  // The persona is the one model call a store with no products still makes: it
  // is a judgement about the business, and a shop with an empty catalogue is
  // still a shop. The answer names a language and a country the store's own
  // settings contradict, so the test can see which one is kept.
  llm.setDefault('persona', () =>
    JSON.stringify({
      business_description:
        'Acme Candles sells hand-poured scented candles for the home. The range is small and made in batches.',
      product_categories: ['scented candles'],
      main_language: 'fr',
      country: 'FR',
      audience: 'People furnishing a home',
      brand_tone: 'warm and plain',
    }),
  )
  // Seed keywords, from the profile the step before produced. The store has no
  // families, so this is the smallest honest answer a model could give.
  llm.setDefault('seeds', () => JSON.stringify({ keywords: ['scented candles'] }))

  const deps: IngestionDeps = {
    db: harness.db,
    pool: harness.pool,
    fetcher,
    shopify: new MockShopifyOAuthClient(),
    shop,
    admin: new EmptyStore(),
    connections,
    llm,
    distillPrompt: { version: 'distill.v1', text: 'extract only' },
    personaPrompt: { version: 'persona.v1', text: 'describe the shop' },
    seedsPrompt: { version: 'seeds.v1', text: 'propose search terms' },
    seo: new MockSeoDataProvider({
      keywordMetrics: { 'scented candles': { monthlySearchVolume: 4400, competition: 0.3 } },
      serp: {
        'scented candles': [
          { position: 1, url: 'https://rival-candles.com/', domain: 'rival-candles.com', title: null },
        ],
      },
    }),
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
  // The retry sweep queues a real job, and the case below runs it. The queue's
  // tables are the worker's own, not our migrations', so a test that exercises
  // queued work installs them the way the worker would.
  const url = new URL(TEST_DATABASE_URL)
  url.pathname = `/${harness.databaseName}`
  workerUtils = await installQueueSchema(url.toString())
}, 60_000)

afterAll(async () => {
  await workerUtils?.release()
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
  await harness.pool.query(TRUNCATE_QUEUE_SQL)
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

    // Permission granted, so the run carries straight on: it reads the store,
    // distils what it found, groups those products into families, builds the
    // store's business profile from them, works out what its customers search
    // for and who else ranks for those searches, and moves the store onto the
    // review screen. Connecting Search Console is a sibling of that last step,
    // not something it waits for — `T3.1` drives it separately from the
    // merchant's own action, not from this dispatcher — and it belongs to
    // a card whose handler this dispatcher does not run, so the walk
    // correctly stops there.
    expect(resumed?.executed).toEqual([
      'oauth_wait',
      'catalog_sync',
      'distill',
      'family_group',
      'persona',
      'keywords_competitors',
      'awaiting_confirmation',
    ])
    expect(resumed?.stoppedBecause).toBe('no_handler')
    expect(resumed?.stoppedAt).toBe('gsc_connect')
    expect(await domainState()).toBe('needs_confirmation')

    const states = await stepStates(jobId)
    expect(states['detect']).toBe('succeeded')
    expect(states['oauth_wait']).toBe('succeeded')
    expect(states['catalog_sync']).toBe('succeeded')
    expect(states['distill']).toBe('succeeded')
    expect(states['family_group']).toBe('succeeded')
    expect(states['persona']).toBe('succeeded')
    expect(states['keywords_competitors']).toBe('succeeded')
    expect(states['awaiting_confirmation']).toBe('succeeded')
    expect(states['gsc_connect']).toBe('pending')
  })

  it('learns what the store calls itself and where it serves, once', async () => {
    await createRun(harness.db, accountId, 'claim:acme.example')
    const w = world('acme.example')
    w.fetcher.serves('https://acme.example/', { headers: { 'x-shopid': '9' }, body: 'acme.myshopify.com' })
    await dispatchIngestion(w.deps, { accountId })
    w.connections.grant({
      accountId,
      shopHandle: 'acme',
      token: 'shpat_x',
      scopes: ['read_products', 'read_orders', 'read_content'],
    })

    await dispatchIngestion(w.deps, { accountId })

    // Both are needed later at moments where asking again would be a network
    // call in the middle of something else: every published article's address
    // is built from the host the storefront serves on, and the store's name is
    // the byline each one carries.
    expect(w.connections.identity).toEqual({
      storefrontHost: 'acme.example',
      shopName: 'Acme Candles',
    })
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

/**
 * Losing a connection is a pause. Without the other half of it the pause was
 * permanent in the quietest possible way: the store moved to "waiting for
 * Shopify", the merchant reconnected, the new token was stored — and nothing
 * moved the store back, so its calendar, its scans and its learning simply
 * stopped, with a working connection and no error anywhere.
 */
describe('when the merchant reconnects the store', () => {
  it('puts the steps that stopped for the dead token back to work', async () => {
    const { jobId } = await createRun(harness.db, accountId, 'claim:acme.example')
    const w = world('acme.example')
    w.fetcher.serves('https://acme.example/', { headers: { 'x-shopid': '9' }, body: 'acme.myshopify.com' })
    await dispatchIngestion(w.deps, { accountId })
    w.connections.grant({ accountId, shopHandle: 'acme', token: 'stale', scopes: ['read_products'] })
    w.shop.rejectsToken()
    await dispatchIngestion(w.deps, { accountId })
    expect((await stepStates(jobId))['oauth_wait']).toBe('failed_terminal')

    // The merchant goes through the connect screen again and the new token is
    // stored; this is what happens next.
    w.connections.grant({
      accountId,
      shopHandle: 'acme',
      token: 'fresh',
      scopes: ['read_products', 'read_orders', 'read_content'],
    })
    w.shop.acceptsToken()
    expect(await resumeAfterReconnect(harness.db, accountId)).toBe('resumed_onboarding')

    expect((await stepStates(jobId))['oauth_wait']).toBe('pending')
    const resumed = await dispatchIngestion(w.deps, { accountId })
    expect(resumed?.executed).toContain('oauth_wait')
    expect(await domainState()).not.toBe('awaiting_shopify_auth')
  })

  it('leaves alone a step that failed for its own reasons', async () => {
    const { jobId } = await createRun(harness.db, accountId, 'claim:acme.example')
    const w = world('acme.example')
    w.fetcher.serves('https://acme.example/', { headers: { 'x-shopid': '9' }, body: 'acme.myshopify.com' })
    await dispatchIngestion(w.deps, { accountId })
    w.connections.grant({ accountId, shopHandle: 'acme', token: 'stale', scopes: ['read_products'] })
    w.shop.rejectsToken()
    await dispatchIngestion(w.deps, { accountId })

    // A different step, dead for a reason a new token says nothing about.
    await harness.pool.query(
      `update job_steps set state = 'failed_terminal', last_error_class = 'no_domain'
         where job_id = $1 and step = 'catalog_sync'`,
      [jobId],
    )

    await resumeAfterReconnect(harness.db, accountId)

    const states = await stepStates(jobId)
    expect(states['oauth_wait']).toBe('pending')
    expect(states['catalog_sync']).toBe('failed_terminal')
  })

  it('returns a store that had already finished onboarding to work rather than to the connect screen', async () => {
    const { jobId } = await createRun(harness.db, accountId, 'claim:acme.example')
    await harness.pool.query(`update job_steps set state = 'succeeded' where job_id = $1`, [jobId])
    // The connection broke after onboarding was over, so the store is sitting
    // on the reconnect screen with no work left to redo.
    await harness.pool.query(
      `update domains set state = 'awaiting_shopify_auth' where account_id = $1`,
      [accountId],
    )

    expect(await resumeAfterReconnect(harness.db, accountId)).toBe('restored_ready')
    expect(await domainState()).toBe('ready_for_planning')
  })

  it('does nothing for a store that is not waiting on Shopify at all', async () => {
    await createRun(harness.db, accountId, 'claim:acme.example')
    expect(await resumeAfterReconnect(harness.db, accountId)).toBe('nothing_to_resume')
  })
})

describe('an account with nothing to dispatch', () => {
  it('does nothing rather than inventing a run', async () => {
    const w = world('acme.example')
    expect(await dispatchIngestion(w.deps, { accountId })).toBeUndefined()
  })
})

/**
 * The defect this suite exists to have caught and did not: a step that fails in
 * a way worth retrying writes down when to come back, and until the sweep
 * existed nobody ever did.
 *
 * Driven the whole way round rather than at the sweep: the store's first step
 * fails the way a slow storefront fails it, time passes, and the run finishes
 * with **nothing a person did** in between. The only link not exercised here is
 * the queue library handing the row it wrote to the handler it was registered
 * with, which is what `bootstrapWorker` does and what the worker's own tests
 * cover.
 */
describe('a store whose first step failed once', () => {
  it('finishes on its own, with nobody touching it', async () => {
    const { jobId } = await createRun(harness.db, accountId, 'claim:acme.example')
    const w = world('acme.example')
    // Nothing answers for the storefront on the first attempt.
    w.fetcher.refuses('https://acme.example/')

    const first = await dispatchIngestion(w.deps, { accountId })
    expect(first?.stoppedBecause).toBe('retry_scheduled')
    expect((await stepStates(jobId))['detect']).toBe('failed_retryable')

    // The storefront is back. Nobody tells us that; the only thing that happens
    // next is time passing.
    w.fetcher.serves('https://acme.example/', {
      headers: { 'x-shopid': '9' },
      body: '<script>window.Shopify = {}; "acme-candles.myshopify.com"</script>',
    })

    // Time passing, which is the only thing that happens between the failure
    // and the recovery. Moved on the row rather than on a clock the sweep is
    // handed, because the dispatcher reads the real clock too — a fake time
    // known only to the sweep would queue a job the dispatcher then refused.
    await harness.pool.query(
      "UPDATE job_steps SET next_attempt_at = now() - interval '1 second' WHERE job_id = $1 AND step = 'detect'",
      [jobId],
    )

    const swept = await sweepStalledIngestionRuns({ getDb: () => harness.db })
    expect(swept).toEqual({ due: 1, queued: 1 })

    // The queued job, run by the handler the worker would run it with.
    clearTasks()
    resetIngestionTaskRegistration()
    registerIngestionTasks(() => w.deps)
    const queued = await harness.pool.query<{ task_identifier: string; key: string }>(
      "SELECT task_identifier, key FROM graphile_worker.jobs WHERE task_identifier = 'ingestion_dispatch'",
    )
    expect(queued.rows).toHaveLength(1)
    expect(queued.rows[0]!.key).toBe(`ingestion_dispatch:${accountId}`)

    const handler = taskList()['ingestion_dispatch']!
    await handler({ accountId }, {} as never)

    // The step that failed has succeeded, and the run is where a first-time
    // store belongs: waiting for the merchant to press Approve.
    expect((await stepStates(jobId))['detect']).toBe('succeeded')
    expect(await domainState()).toBe('awaiting_shopify_auth')

    clearTasks()
    resetIngestionTaskRegistration()
  })
})

/**
 * What an operator is told when a store cannot be read.
 *
 * The step wraps whatever went wrong in its own sentence — "could not read
 * acme.example to work out what it runs on" — and that sentence was all that
 * reached the row and the log. A refused connection, a redirect loop and a
 * response too big for the budget were one indistinguishable failure, which is
 * how a size limit nobody had written down stayed invisible for so long.
 */
describe('a store that could not be read', () => {
  it('records why, not only that', async () => {
    const { jobId } = await createRun(harness.db, accountId, 'claim:acme.example')
    const w = world('acme.example')
    w.fetcher.answers.set(
      'https://acme.example/',
      new Error('Body exceeded 600000 bytes.'),
    )

    const result = await dispatchIngestion(w.deps, { accountId })
    expect(result?.stoppedBecause).toBe('retry_scheduled')

    const { rows } = await harness.pool.query<{ last_error: string }>(
      "SELECT last_error FROM job_steps WHERE job_id = $1 AND step = 'detect'",
      [jobId],
    )
    expect(rows[0]!.last_error).toContain('Could not read acme.example')
    expect(rows[0]!.last_error).toContain('Body exceeded 600000 bytes.')
  })
})
