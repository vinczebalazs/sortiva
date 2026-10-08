import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Runner, TaskList } from 'graphile-worker'
import { installShopifyStore } from '../connectors/shopify/install.ts'
import { verifyShopifyWebhook } from '../connectors/shopify/webhooks.ts'
import { optionalEnv } from '../config/env.ts'
import { banners, thinState, type Banner, type ThinState } from '../core/status.ts'
import { syncProgress, type SyncProgress } from '../core/learn/sync.ts'
import { createTestDb, type TestDb } from '../db/test-db.ts'
import { startFakeAnthropic, type FakeAnthropic } from '../fakes/fake-anthropic/server.ts'
import { startFakeDataForSeo, type FakeDataForSeo } from '../fakes/fake-dataforseo/server.ts'
import { DataForSeoDemand } from '../vendors/dataforseo/client.ts'
import { PINNED_VERSION } from '../fakes/fake-shopify/schema/pinned.ts'
import { startFakeShopify, type FakeShopify } from '../fakes/fake-shopify/server.ts'
import type { FixtureStore } from '../fakes/fake-shopify/state.ts'
import { AnthropicLlm } from '../vendors/anthropic/client.ts'
import { ALL_JOBS } from '../jobs/all.ts'
import { enqueueNightlySync, requestSync, startInitialLearn } from '../jobs/catalog.ts'
import type { Deps, Hooks } from '../jobs/deps.ts'
import { acceptDelivery } from '../jobs/intake.ts'
import { taskList } from '../jobs/runtime/task.ts'
import { nightlySweep } from '../jobs/sweepers.ts'
import { dailySweep, requestDiscovery } from '../jobs/topics.ts'
import { finishSetup, skipSearchConsole } from '../core/settings.ts'
import { confirmProfile, setupState } from '../core/setup.ts'
import type { DiscoveryOutcome } from '../core/topics/discover.ts'
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
  dataforseo: FakeDataForSeo
  worker: Runner
  install: (store: string | FixtureStore, opts?: { alreadyLoaded?: boolean }) => Promise<{ id: number; domain: string }>
  storeId: (domain: string) => Promise<number>
  syncNow: (storeId: number) => Promise<'started' | 'already_running'>
  enqueueNightlySync: (storeId: number) => Promise<void>
  syncProgress: (storeId: number) => Promise<SyncProgress>
  banners: (storeId: number) => Promise<Banner[]>
  thinState: (storeId: number) => Promise<ThinState>
  /** Confirms the drafted profile, skips Search Console, picks export, and starts topic-finding, as a merchant would. */
  completeSetup: (storeId: number) => Promise<void>
  /** Sends topic-finding out again now, as the low-queue rule or a profile change would. */
  rediscover: (storeId: number) => Promise<void>
  /** The output topic-finding recorded for its latest run on this store. */
  lastDiscovery: (storeId: number) => Promise<DiscoveryOutcome>
  /** Runs today's daily pick for the store, as the hourly sweep does at its publish hour, which also starts writing. */
  writeToday: (storeId: number, localDate?: string) => Promise<string>
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
export async function startPipeline(options: { webhookDebounceMs?: number; writing?: boolean } = {}): Promise<Pipeline> {
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
  // DataForSEO is recorded only with RECORD_DATAFORSEO=1, separately, because its balance is small.
  const dataforseo = await startFakeDataForSeo({ record: process.env.RECORD_DATAFORSEO === '1', realLogin: optionalEnv('DATAFORSEO_LOGIN'), realPassword: optionalEnv('DATAFORSEO_PASSWORD') })

  deps = {
    pool: db.pool,
    shopifyApp: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, apiVersion: PINNED_VERSION, baseUrlFor: shopify.baseUrlFor },
    shopifyClient: { baseDelayMs: 20 },
    llm: new AnthropicLlm(db.pool, { apiKey: 'scenario-key', baseURL: anthropic.url }),
    demand: new DataForSeoDemand(db.pool, { login: dataforseo.login, password: dataforseo.password, baseUrl: dataforseo.url, pollMs: process.env.RECORD_DATAFORSEO === '1' ? 5_000 : 20 }),
    webhookDebounceMs: options.webhookDebounceMs ?? 1_500,
    hooks,
  }
  const tasks: TaskList = { ...taskList(deps, ALL_JOBS), nightly_sweep: nightlySweep(db.pool), daily_sweep: dailySweep(db.pool) }
  // Scenarios about the schedule alone switch writing off: the topic counts as written, and no model is paid.
  if (options.writing === false) {
    tasks.write_article = async (payload) => {
      await db.pool.query(`update topics set state = 'written' where id = $1 and state = 'scheduled'`, [(payload as { topicId: number }).topicId])
    }
  }
  const worker = await startWorker({ connectionString: db.url, taskList: tasks, concurrency: 4, quiet: true })

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
    dataforseo,
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
    completeSetup: async (id) => {
      const state = await setupState(db.pool, id)
      if (!state.profile) throw new Error(`store ${id} has no drafted profile (setup step ${state.step})`)
      const confirmed = await confirmProfile(db.pool, id, { ...state.profile, neverSay: state.profile.neverSay })
      if (!confirmed.ok) throw new Error(JSON.stringify(confirmed.errors))
      await skipSearchConsole(db.pool, id)
      const done = await finishSetup(db.pool, id, { mode: 'export', blog: null, publishAs: 'live', publishHour: 9, reviewFirst: false })
      if (!done.ok) throw new Error(JSON.stringify(done.errors))
      await requestDiscovery(db.pool, id, 'setup', new Date().toISOString())
    },
    rediscover: async (id) => {
      await requestDiscovery(db.pool, id, 'low_queue', new Date().toISOString())
    },
    lastDiscovery: async (id) => {
      const { rows } = await db.pool.query(`select output from job_ledger where task = 'find_topics' and store_id = $1 order by completed_at desc limit 1`, [id])
      if (!rows[0]) throw new Error(`no finished topic-finding for store ${id}`)
      return rows[0].output
    },
    writeToday: async (id, localDate) => {
      const { rows } = await db.pool.query<{ d: string }>(`select to_char((now() at time zone timezone)::date, 'YYYY-MM-DD') as d from stores where id = $1`, [id])
      const date = localDate ?? rows[0]!.d
      await worker.addJob('daily_pick', { storeId: id, localDate: date }, { jobKey: `daily_pick:${id}:${date}` })
      return date
    },
    settle,
    retryFailedNow: async () => {
      await db.pool.query(`update graphile_worker._private_jobs set run_at = now() where attempts > 0 and locked_at is null`)
    },
    stop: async () => {
      await worker.stop()
      await shopify.close()
      await anthropic.close()
      await dataforseo.close()
      await new Promise<void>((r) => receiver.close(() => r()))
      await db.drop()
    },
  }
}
