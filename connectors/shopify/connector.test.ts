import { afterAll, beforeAll } from 'vitest'
import { encrypt } from '../../config/crypto.ts'
import { createTestDb, type TestDb } from '../../db/test-db.ts'
import { PINNED_VERSION } from '../../fakes/fake-shopify/schema/pinned.ts'
import { startFakeShopify, type FakeShopify } from '../../fakes/fake-shopify/server.ts'
import { fixture } from '../../scenarios/fixtures/index.ts'
import { describeConnectorBehaviour, type Backend } from './behaviour.ts'
import { ShopifyClient } from './client.ts'
import { ShopifyConnector } from './connector.ts'
import { installShopifyStore } from './install.ts'
import { StoredTokens, type ShopifyAppConfig } from './tokens.ts'

let db: TestDb
let fake: FakeShopify
let backend: Backend

beforeAll(async () => {
  db = await createTestDb()
  fake = await startFakeShopify({ clientId: 'c', clientSecret: 's' })
  const store = fixture('three-en')
  const domain = store.shop.myshopifyDomain
  fake.addShop(store)
  const app: ShopifyAppConfig = { clientId: 'c', clientSecret: 's', apiVersion: PINNED_VERSION, baseUrlFor: fake.baseUrlFor }
  const storeId = await installShopifyStore(db.pool, app, domain, fake.mintSessionToken(domain))
  const client = new ShopifyClient(app, domain, new StoredTokens(db.pool, app, storeId), { baseDelayMs: 10 })
  const connector = new ShopifyConnector(client)

  backend = {
    connector,
    pinnedVersion: PINNED_VERSION,
    lastApiVersion: () => client.lastApiVersion,
    cleanUp: async () => {},
    deadTokenConnector: async () => {
      const { rows } = await db.pool.query<{ id: number }>(
        `insert into stores (shop_domain, access_token_enc, access_token_expires_at, refresh_token_enc)
         values ($1, $2, now() - interval '1 hour', $3) returning id`,
        [`dead-${Date.now()}.myshopify.com`, encrypt('shpat_dead'), encrypt('shprt_dead')],
      )
      return new ShopifyConnector(new ShopifyClient({ ...app, baseUrlFor: () => fake.baseUrlFor(domain) }, domain, new StoredTokens(db.pool, app, rows[0]!.id), { baseDelayMs: 10 }))
    },
    withoutScope: async (scope) => {
      fake.revokeScope(domain, scope)
      return { connector, restore: async () => void fake.shop(domain).grantedScopes.push(scope) }
    },
  }
})
afterAll(async () => {
  await fake?.close()
  await db?.drop()
})

describeConnectorBehaviour('fake Shopify', () => backend)
