import type { Db } from '../../db/pool.ts'
import { ShopifyClient, type ClientOptions } from './client.ts'
import { ShopifyConnector } from './connector.ts'
import { exchangeSessionToken, storeGrant, StoredTokens, type ShopifyAppConfig } from './tokens.ts'

/**
 * Turns the embedded page's first session token into a store: tokens stored encrypted, shop details
 * read from Shopify. A reinstall reopens the existing store and keeps its data.
 */
export async function installShopifyStore(db: Db, app: ShopifyAppConfig, shopDomain: string, sessionToken: string, clientOptions?: ClientOptions): Promise<number> {
  const grant = await exchangeSessionToken(app, shopDomain, sessionToken)
  const { rows } = await db.query<{ id: number }>(
    `insert into stores (shop_domain) values ($1)
     on conflict (shop_domain) do update set closed_at = null, delete_after = null
     returning id`,
    [shopDomain],
  )
  const storeId = rows[0]!.id
  await db.query('insert into store_flags (store_id) values ($1) on conflict do nothing', [storeId])
  await storeGrant(db, storeId, grant)

  const connector = new ShopifyConnector(new ShopifyClient(app, shopDomain, new StoredTokens(db, app, storeId), clientOptions))
  const shop = await connector.shopInfo()
  const scopes = await connector.grantedScopes()
  await db.query(
    `update stores set name = $2, storefront_host = $3, primary_locale = $4, country = $5, timezone = $6, scopes = $7 where id = $1`,
    [storeId, shop.name, shop.storefrontHost, shop.primaryLocale, shop.country, shop.timezone, scopes],
  )
  return storeId
}
