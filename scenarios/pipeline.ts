import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Runner } from 'graphile-worker'
import { installShopifyStore } from '../connectors/shopify/install.ts'
import { verifyShopifyWebhook } from '../connectors/shopify/webhooks.ts'
import { optionalEnv } from '../config/env.ts'
import { banners, thinState, type Banner, type ThinState } from '../core/status.ts'
import { syncProgress, type SyncProgress } from '../core/learn/sync.ts'
import { createTestDb, type TestDb } from '../db/test-db.ts'
import { startFakeAnthropic, type FakeAnthropic } from '../fakes/fake-anthropic/server.ts'
import { PINNED_VERSION } from '../fakes/fake-shopify/schema/pinned.ts'
import { startFakeShopify, type FakeShopify } from '../fakes/fake-shopify/server.ts'
import type { FixtureStore } from '../fakes/fake-shopify/state.ts'
import { AnthropicLlm } from '../vendors/anthropic/client.ts'
import { ALL_JOBS } from '../jobs/all.ts'
import { enqueueNightlySync, requestSync, startInitialLearn } from '../jobs/catalog.ts'
import type { Deps, Hooks } from '../jobs/deps.ts'
import { acceptDelivery } from '../jobs/intake.ts'
import { taskList } from '../jobs/runtime/task.ts'
import { startWorker } from '../jobs/worker.ts'
import { fixture } from './fixtures/index.ts'

const CLIENT_ID = 'scenario-client'
const CLIENT_SECRET = 'scenario-secret'

export type Pipeline = {
  db: TestDb
  deps: Deps
  hooks: Hooks
  shopify: FakeShopify
  anthropic: FakeAnthropic
  worker: Runner
  install: (store: string | FixtureStore, opts?: { alreadyLoaded?: boolean }) => Promise<{ id: number; domain: string }>
  storeId: (domain: string) => Promise<number>
  syncNow: (storeId: number) => Promise<'started' | 'already_running'>
  enqueueNightlySync: (storeId: number) => Promise<void>
  syncProgress: (storeId: number) => Promise<SyncProgress>
  banners: (storeId: number) => Promise<Banner[]>
  thinState: (storeId: number) => Promise<ThinState>
  /** Waits until no job is running and none is due in the next 30 seconds. */
  settle: (timeoutMs?: number) => Promise<void>
  retryFailedNow: () => Promise<void>
  stop: () => Promise<void>
}

/**
 * The whole pipeline for one test file: its own database, the fake vendors as HTTP servers,
 * a webhook receiver standing in for the app's route, and a real worker running every job.
 * RECORD=1 lets the fake Anthropic call the real API for requests it has no recording of.
 */
export async function startPipeline(options: { webhookDebounceMs?: number } = {}): Promise<Pipeline> {
  const db = await createTestDb()
  const hooks: Hooks = {}

  let deps!: Deps
  const receiver = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const delivery = verifyShopifyWebhook(req.headers as Record<string, string>, Buffer.concat(chunks).toString('utf8'), CLIENT_SECRET)
    if (!delivery) {
      res.writeHead(401).end()
      return
    }
    await acceptDelivery(deps, delivery)
    res.writeHead(200).end()
  })
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r))
  const webhookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/webhooks`

  const shopify = await startFakeShopify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, webhookUrl })
  const record = process.env.RECORD === '1'
  const anthropic = await startFakeAnthropic({ record, apiKey: optionalEnv('ANTHROPIC_API_KEY') })

  deps = {
    pool: db.pool,
    shopifyApp: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, apiVersion: PINNED_VERSION, baseUrlFor: shopify.baseUrlFor },
    shopifyClient: { baseDelayMs: 20 },
    llm: new AnthropicLlm(db.pool, { apiKey: 'scenario-key', baseURL: anthropic.url }),
    webhookDebounceMs: options.webhookDebounceMs ?? 1_500,
    hooks,
  }
  const worker = await startWorker({ connectionString: db.url, taskList: taskList(deps, ALL_JOBS), concurrency: 4, quiet: true })

  const storeId = async (domain: string) => {
    const { rows } = await db.pool.query<{ id: number }>('select id from stores where shop_domain = $1', [domain])
    if (!rows[0]) throw new Error(`no store ${domain}`)
    return rows[0].id
  }

  const settle = async (timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const { rows } = await db.pool.query<{ n: number }>(
        `select count(*)::int as n from graphile_worker.jobs
         where attempts < max_attempts and (locked_at is not null or run_at < now() + interval '30 seconds')`,
      )
      if (rows[0]!.n === 0) return
      if (Date.now() > deadline) {
        const pending = await db.pool.query('select task_identifier, attempts, last_error, run_at from graphile_worker.jobs')
        throw new Error(`jobs still pending after ${timeoutMs} ms: ${JSON.stringify(pending.rows)}`)
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  return {
    db,
    deps,
    hooks,
    shopify,
    anthropic,
    worker,
    install: async (store, opts = {}) => {
      const data = typeof store === 'string' ? fixture(store) : store
      const domain = data.shop.myshopifyDomain
      if (!opts.alreadyLoaded) shopify.addShop(data)
      const id = await installShopifyStore(db.pool, deps.shopifyApp, domain, shopify.mintSessionToken(domain), deps.shopifyClient)
      await startInitialLearn(db.pool, id)
      return { id, domain }
    },
    storeId,
    syncNow: (id) => requestSync(db.pool, id),
    enqueueNightlySync: async (id) => enqueueNightlySync(db.pool, id, new Date().toISOString().slice(0, 10)),
    syncProgress: (id) => syncProgress(db.pool, id),
    banners: (id) => banners(db.pool, id),
    thinState: (id) => thinState(db.pool, id),
    settle,
    retryFailedNow: async () => {
      await db.pool.query(`update graphile_worker._private_jobs set run_at = now() where attempts > 0 and locked_at is null`)
    },
    stop: async () => {
      await worker.stop()
      await shopify.close()
      await anthropic.close()
      await new Promise<void>((r) => receiver.close(() => r()))
      await db.drop()
    },
  }
}
