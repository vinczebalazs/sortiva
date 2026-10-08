import { decrypt, encrypt } from '../../config/crypto.ts'
import type { Db } from '../../db/pool.ts'
import { AccessLostError, TransientStoreError } from '../types.ts'

export type ShopifyAppConfig = {
  clientId: string
  clientSecret: string
  apiVersion: string
  /** Base URL standing in for https://{shop}; the fake Shopify supplies one per shop. */
  baseUrlFor: (shopDomain: string) => string
}

export type TokenGrant = {
  access_token: string
  expires_in: number
  refresh_token: string
  refresh_token_expires_in: number
}

const TOKEN_REFRESH_NAMESPACE = 0x544f4b4e
// Refresh a little before the hour is up, so a token never expires between check and use.
const REFRESH_MARGIN_MS = 5 * 60 * 1000

async function postToken(app: ShopifyAppConfig, shopDomain: string, params: Record<string, string>): Promise<Response> {
  try {
    return await fetch(`${app.baseUrlFor(shopDomain)}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...params }),
    })
  } catch (error) {
    throw new TransientStoreError(`token endpoint unreachable for ${shopDomain}: ${(error as Error).message}`)
  }
}

/** Swaps the session token App Bridge gives the embedded page for an expiring offline token. */
export async function exchangeSessionToken(app: ShopifyAppConfig, shopDomain: string, sessionToken: string): Promise<TokenGrant> {
  const res = await postToken(app, shopDomain, {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: sessionToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    expiring: '1',
  })
  if (!res.ok) throw new AccessLostError(`token exchange for ${shopDomain} refused with HTTP ${res.status}`)
  return (await res.json()) as TokenGrant
}

export async function storeGrant(db: Db, storeId: number, grant: TokenGrant, now = Date.now()): Promise<void> {
  await db.query(
    `update stores set access_token_enc = $2, access_token_expires_at = $3, refresh_token_enc = $4, refresh_token_expires_at = $5 where id = $1`,
    [
      storeId,
      encrypt(grant.access_token),
      new Date(now + grant.expires_in * 1000),
      encrypt(grant.refresh_token),
      new Date(now + grant.refresh_token_expires_in * 1000),
    ],
  )
}

type TokenRow = {
  shop_domain: string
  access_token_enc: string | null
  access_token_expires_at: Date | null
  refresh_token_enc: string | null
}

/**
 * Hands out a usable access token for one store. Renewal happens under a per-store
 * transaction lock and re-reads the row first, so two workers never both spend the
 * single-use refresh token.
 */
export class StoredTokens {
  constructor(
    private readonly db: Db,
    private readonly app: ShopifyAppConfig,
    readonly storeId: number,
  ) {}

  async accessToken(): Promise<string> {
    const row = await this.read(this.db)
    if (row.access_token_enc && row.access_token_expires_at && row.access_token_expires_at.getTime() - REFRESH_MARGIN_MS > Date.now()) {
      return decrypt(row.access_token_enc)
    }
    return this.refresh(false)
  }

  /** `force` renews even if the stored expiry looks fine, for when Shopify has just said 401. */
  async refresh(force: boolean): Promise<string> {
    const client = await this.db.connect()
    try {
      await client.query('begin')
      await client.query('select pg_advisory_xact_lock($1, $2)', [TOKEN_REFRESH_NAMESPACE, this.storeId])
      const row = await this.read(client)
      const fresh = row.access_token_expires_at && row.access_token_expires_at.getTime() - REFRESH_MARGIN_MS > Date.now()
      if (fresh && row.access_token_enc && !force) {
        await client.query('commit')
        return decrypt(row.access_token_enc)
      }
      if (!row.refresh_token_enc) throw new AccessLostError(`store ${this.storeId} has no refresh token; it must be reinstalled`)
      const res = await postToken(this.app, row.shop_domain, { grant_type: 'refresh_token', refresh_token: decrypt(row.refresh_token_enc) })
      if (res.status >= 500) throw new TransientStoreError(`token refresh for ${row.shop_domain} failed with HTTP ${res.status}`)
      if (!res.ok) throw new AccessLostError(`token refresh for ${row.shop_domain} refused with HTTP ${res.status}`)
      const grant = (await res.json()) as TokenGrant
      await storeGrant(client as unknown as Db, this.storeId, grant)
      await client.query('commit')
      return grant.access_token
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  private async read(db: Pick<Db, 'query'>): Promise<TokenRow> {
    const { rows } = await db.query<TokenRow>(
      'select shop_domain, access_token_enc, access_token_expires_at, refresh_token_enc from stores where id = $1',
      [this.storeId],
    )
    if (!rows[0]) throw new AccessLostError(`store ${this.storeId} does not exist`)
    return rows[0]
  }
}
