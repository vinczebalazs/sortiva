import { env } from '../config/env.ts'
import { createPool } from '../db/pool.ts'
import { AnthropicLlm } from '../vendors/anthropic/client.ts'
import { CONFIG } from '../core/config.ts'
import { ALL_JOBS } from './all.ts'
import type { Deps } from './deps.ts'
import { taskList } from './runtime/task.ts'
import { CRONTAB, nightlySweep } from './sweepers.ts'
import { startWorker } from './worker.ts'

// The worker process: every job and sweeper, against the real vendors.
const pool = createPool()
const deps: Deps = {
  pool,
  shopifyApp: {
    clientId: env('SHOPIFY_CLIENT_ID'),
    clientSecret: env('SHOPIFY_CLIENT_SECRET'),
    apiVersion: env('SHOPIFY_API_VERSION'),
    baseUrlFor: (shop) => `https://${shop}`,
  },
  llm: new AnthropicLlm(pool, { apiKey: env('ANTHROPIC_API_KEY') }),
  webhookDebounceMs: CONFIG.webhookDebounceMs,
  hooks: {},
}

const runner = await startWorker({
  connectionString: env('DATABASE_URL'),
  taskList: { ...taskList(deps, ALL_JOBS), nightly_sweep: nightlySweep(pool) },
  crontab: CRONTAB,
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await runner.stop()
    await pool.end()
    process.exit(0)
  })
}
await runner.promise
