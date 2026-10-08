import pg from 'pg'
import { env, optionalEnv } from '../config/env.ts'
import { applySchema } from '../db/test-db.ts'
import { createPool } from '../db/pool.ts'
import { installShopifyStore } from '../connectors/shopify/install.ts'
import { startFakeAnthropic } from '../fakes/fake-anthropic/server.ts'
import { PINNED_VERSION } from '../fakes/fake-shopify/schema/pinned.ts'
import { startFakeShopify } from '../fakes/fake-shopify/server.ts'
import { ALL_JOBS } from '../jobs/all.ts'
import { startInitialLearn } from '../jobs/catalog.ts'
import type { Deps } from '../jobs/deps.ts'
import { taskList } from '../jobs/runtime/task.ts'
import { startWorker } from '../jobs/worker.ts'
import { fixture } from '../scenarios/fixtures/index.ts'
import { AnthropicLlm } from '../vendors/anthropic/client.ts'
import { finishSetup, skipSearchConsole } from '../core/settings.ts'
import { confirmProfile, setupState } from '../core/setup.ts'
import { requestDiscovery } from '../jobs/topics.ts'
import { startFakeDataForSeo } from '../fakes/fake-dataforseo/server.ts'
import { DataForSeoDemand } from '../vendors/dataforseo/client.ts'

/**
 * Rebuilds the local database and fills it with fixture stores through the real pipeline, with the
 * fake Shopify and the recorded model answers, so `pnpm preview` has something to show.
 * Usage: pnpm seed:preview [fixture[:done] ...]   (default: rich-hu rich-en empty-en)
 * A fixture written as name:done is also taken through setup (profile confirmed as drafted, Search
 * Console skipped, export chosen) and its topics found, so Home has a queue to show.
 * name:written goes further: review first is switched on and today's article is written, so the
 * Articles and Article screens have something to show (from recordings; RECORD=1 for new ones).
 */
const args = process.argv.slice(2).length ? process.argv.slice(2) : ['rich-hu', 'rich-en', 'empty-en']
const names = args.map((a) => a.replace(/:(done|written)$/, ''))
const finish = new Set(args.filter((a) => /:(done|written)$/.test(a)).map((a) => a.replace(/:(done|written)$/, '')))
const write = new Set(args.filter((a) => a.endsWith(':written')).map((a) => a.replace(/:written$/, '')))
const url = new URL(env('DATABASE_URL'))
const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() })
await admin.connect()
await admin.query(`drop database if exists "${url.pathname.slice(1)}" with (force)`)
await admin.query(`create database "${url.pathname.slice(1)}"`)
await admin.end()
await applySchema(url.toString())

const pool = createPool()
const shopify = await startFakeShopify({ clientId: 'preview', clientSecret: 'preview' })
// RECORD=1 records model answers the fixtures do not have yet, as the scenarios do.
const anthropic = await startFakeAnthropic({ record: process.env.RECORD === '1', apiKey: optionalEnv('ANTHROPIC_API_KEY') })
const dataforseo = await startFakeDataForSeo({ record: process.env.RECORD_DATAFORSEO === '1', realLogin: optionalEnv('DATAFORSEO_LOGIN'), realPassword: optionalEnv('DATAFORSEO_PASSWORD') })
const deps: Deps = {
  pool,
  shopifyApp: { clientId: 'preview', clientSecret: 'preview', apiVersion: PINNED_VERSION, baseUrlFor: shopify.baseUrlFor },
  llm: new AnthropicLlm(pool, { apiKey: 'preview', baseURL: anthropic.url }),
  demand: new DataForSeoDemand(pool, { login: dataforseo.login, password: dataforseo.password, baseUrl: dataforseo.url, pollMs: process.env.RECORD_DATAFORSEO === '1' ? 5_000 : 20 }),
  webhookDebounceMs: 1000,
  hooks: {},
}
const worker = await startWorker({ connectionString: url.toString(), taskList: taskList(deps, ALL_JOBS), quiet: true })
const settle = async () => {
  for (;;) {
    const { rows } = await pool.query<{ n: number }>('select count(*)::int as n from graphile_worker.jobs where attempts < max_attempts')
    if (rows[0]!.n === 0) break
    await new Promise((r) => setTimeout(r, 200))
  }
}
const ids = new Map<string, number>()
for (const name of names) {
  const store = fixture(name)
  shopify.addShop(store)
  const id = await installShopifyStore(pool, deps.shopifyApp, store.shop.myshopifyDomain, shopify.mintSessionToken(store.shop.myshopifyDomain))
  ids.set(name, id)
  await startInitialLearn(pool, id)
}
await settle()
for (const name of finish) {
  const id = ids.get(name)!
  const { profile } = await setupState(pool, id)
  if (!profile) continue
  await confirmProfile(pool, id, profile)
  await skipSearchConsole(pool, id)
  await finishSetup(pool, id, { mode: 'export', blog: null, publishAs: 'live', publishHour: 9, reviewFirst: write.has(name) })
  await requestDiscovery(pool, id, 'setup', new Date().toISOString())
}
await settle()
for (const name of write) {
  const id = ids.get(name)!
  const { rows } = await pool.query<{ d: string }>(`select to_char((now() at time zone timezone)::date, 'YYYY-MM-DD') as d from stores where id = $1`, [id])
  await worker.addJob('daily_pick', { storeId: id, localDate: rows[0]!.d })
}
await settle()
await worker.stop()
await shopify.close()
await anthropic.close()
await dataforseo.close()
const { rows } = await pool.query('select shop_domain, setup_step from stores order by id')
for (const r of rows) console.log(`http://localhost:3000/dev?shop=${r.shop_domain}   (${r.setup_step})`)
await pool.end()
