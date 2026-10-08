import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ShopifyAppConfig } from '../../connectors/shopify/tokens.ts'
import { env } from '../../config/env.ts'
import { createPool, type Db } from '../../db/pool.ts'

let pool: Db | undefined

export function db(): Db {
  pool ??= createPool()
  return pool
}

export function shopifyApp(): ShopifyAppConfig {
  return {
    clientId: env('SHOPIFY_CLIENT_ID'),
    clientSecret: env('SHOPIFY_CLIENT_SECRET'),
    apiVersion: env('SHOPIFY_API_VERSION'),
    baseUrlFor: (shop) => process.env.SHOPIFY_BASE_URL_OVERRIDE?.replace('{shop}', shop) ?? `https://${shop}`,
  }
}

const APP_TOKEN_SECONDS = 15 * 60

/** Our own bearer token: the screens never hold a platform token, only this, scoped to one store. */
export function signAppToken(storeId: number, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ sid: storeId, exp: Math.floor(now / 1000) + APP_TOKEN_SECONDS })).toString('base64url')
  const signature = createHmac('sha256', env('APP_TOKEN_SECRET')).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

export function verifyAppToken(token: string, now = Date.now()): number | null {
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return null
  const expected = createHmac('sha256', env('APP_TOKEN_SECRET')).update(payload).digest()
  const given = Buffer.from(signature, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sid: number; exp: number }
  return claims.exp * 1000 > now ? claims.sid : null
}

export function requireStore(request: Request): number {
  const header = request.headers.get('authorization') ?? ''
  const storeId = header.startsWith('Bearer ') ? verifyAppToken(header.slice(7)) : null
  if (storeId === null) throw Response.json({ error: 'unauthorized' }, { status: 401 })
  return storeId
}
