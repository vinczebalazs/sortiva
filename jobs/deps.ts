import { ShopifyClient, type ClientOptions } from '../connectors/shopify/client.ts'
import { ShopifyConnector } from '../connectors/shopify/connector.ts'
import { StoredTokens, type ShopifyAppConfig } from '../connectors/shopify/tokens.ts'
import type { StoreConnector } from '../connectors/types.ts'
import type { LearnDeps } from '../core/learn/sync.ts'
import type { Llm } from '../core/llm.ts'
import type { Db } from '../db/pool.ts'

export type Hooks = {
  checkpoint?: (name: string, n: number) => void | Promise<void>
  jobStarted?: (storeId: number, task: string) => void | Promise<void>
  jobFinished?: (storeId: number, task: string) => void | Promise<void>
}

export type Deps = {
  pool: Db
  shopifyApp: ShopifyAppConfig
  shopifyClient?: ClientOptions
  llm: Llm
  webhookDebounceMs: number
  hooks: Hooks
}

export async function connectorFor(deps: Deps, storeId: number): Promise<StoreConnector> {
  const { rows } = await deps.pool.query<{ shop_domain: string }>('select shop_domain from stores where id = $1', [storeId])
  if (!rows[0]) throw new Error(`store ${storeId} does not exist`)
  const tokens = new StoredTokens(deps.pool, deps.shopifyApp, storeId)
  return new ShopifyConnector(new ShopifyClient(deps.shopifyApp, rows[0].shop_domain, tokens, deps.shopifyClient))
}

export async function learnDeps(deps: Deps, storeId: number): Promise<LearnDeps> {
  return {
    db: deps.pool,
    llm: deps.llm,
    connector: await connectorFor(deps, storeId),
    checkpoint: (name, n) => deps.hooks.checkpoint?.(name, n),
  }
}
