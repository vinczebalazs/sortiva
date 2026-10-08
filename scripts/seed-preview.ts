import pg from 'pg'
import { env } from '../config/env.ts'
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

/**
 * Rebuilds the local database and fills it with fixture stores through the real pipeline, with the
 * fake Shopify and the recorded model answers, so `pnpm preview` has something to show.
 * Usage: pnpm seed:preview [fixture ...]   (default: rich-hu rich-en empty-en)
 */
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['rich-hu', 'rich-en', 'empty-en']
const url = new URL(env('DATABASE_URL'))
const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() })
await admin.connect()
await admin.query(`drop database if exists "${url.pathname.slice(1)}" with (force)`)
await admin.query(`create database "${url.pathname.slice(1)}"`)
await admin.end()
await applySchema(url.toString())

const pool = createPool()
const shopify = await startFakeShopify({ clientId: 'preview', clientSecret: 'preview' })
const anthropic = await startFakeAnthropic()
const deps: Deps = {
  pool,
  shopifyApp: { clientId: 'preview', clientSecret: 'preview', apiVersion: PINNED_VERSION, baseUrlFor: shopify.baseUrlFor },
  llm: new AnthropicLlm(pool, { apiKey: 'preview', baseURL: anthropic.url }),
  webhookDebounceMs: 1000,
  hooks: {},
}
const worker = await startWorker({ connectionString: url.toString(), taskList: taskList(deps, ALL_JOBS), quiet: true })
for (const name of names) {
  const store = fixture(name)
  shopify.addShop(store)
  const id = await installShopifyStore(pool, deps.shopifyApp, store.shop.myshopifyDomain, shopify.mintSessionToken(store.shop.myshopifyDomain))
  await startInitialLearn(pool, id)
}
for (;;) {
  const { rows } = await pool.query<{ n: number }>('select count(*)::int as n from graphile_worker.jobs where attempts < max_attempts')
  if (rows[0]!.n === 0) break
  await new Promise((r) => setTimeout(r, 200))
}
await worker.stop()
await shopify.close()
await anthropic.close()
const { rows } = await pool.query('select shop_domain, setup_step from stores order by id')
for (const r of rows) console.log(`http://localhost:3000/dev?shop=${r.shop_domain}   (${r.setup_step})`)
await pool.end()
