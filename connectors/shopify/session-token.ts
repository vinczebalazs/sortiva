import { createHmac, timingSafeEqual } from 'node:crypto'

export type SessionClaims = { shopDomain: string; userId: string; expiresAt: number }

/**
 * Checks an App Bridge session token: signed with our client secret, meant for our app,
 * inside its one-minute window, and issued by the same shop it is addressed to.
 */
export function verifySessionToken(token: string, clientId: string, clientSecret: string, now = Date.now()): SessionClaims | null {
  const [header, payload, signature] = token.split('.')
  if (!header || !payload || !signature) return null
  const expected = createHmac('sha256', clientSecret).update(`${header}.${payload}`).digest()
  const given = Buffer.from(signature, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null

  let claims: { iss?: string; dest?: string; aud?: string; sub?: string; exp?: number; nbf?: number; alg?: string }
  try {
    if (JSON.parse(Buffer.from(header, 'base64url').toString('utf8')).alg !== 'HS256') return null
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const seconds = Math.floor(now / 1000)
  // A few seconds of leeway for clock skew between Shopify and us.
  if (claims.aud !== clientId || !claims.exp || claims.exp < seconds - 5 || !claims.nbf || claims.nbf > seconds + 5) return null
  if (!claims.iss || !claims.dest) return null
  const issHost = new URL(claims.iss).hostname
  const destHost = new URL(claims.dest).hostname
  if (issHost !== destHost || !destHost.endsWith('.myshopify.com')) return null
  return { shopDomain: destHost, userId: claims.sub ?? '', expiresAt: claims.exp * 1000 }
}
