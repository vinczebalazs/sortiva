import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { GraphQLError, execute, parse, specifiedRules, validate, type DocumentNode } from 'graphql'
import { pinnedSchema, PINNED_VERSION } from './schema/pinned.ts'
import { ROOT_FIELD_SCOPES, accessDenied, requestedCost, resolvers, rootFieldNames } from './graphql.ts'
import { loadFixture, randomToken, type FixtureStore, type ShopState } from './state.ts'

const BUCKET_MAX = 2000
const RESTORE_PER_SECOND = 100
const SINGLE_QUERY_MAX = 1000
const ACCESS_TOKEN_SECONDS = 3600
const REFRESH_TOKEN_SECONDS = 7_776_000

const webhookSamples = JSON.parse(
  readFileSync(new URL('./published-samples/webhook-payloads.json', import.meta.url), 'utf8'),
).payloads as Record<string, Record<string, unknown>>

export type FakeShopifyOptions = {
  clientId: string
  clientSecret: string
  // Where the fake sends webhooks, as Shopify would to the URL in the app's configuration.
  webhookUrl?: string
  listLagMs?: number
}

type Failure = { status: number; body: unknown }

export type FakeShopify = {
  url: string
  /** Base URL standing in for https://{shop}; the client appends /admin/... to it. */
  baseUrlFor: (shopDomain: string) => string
  addShop: (fixture: FixtureStore, scopes?: string[]) => ShopState
  shop: (domain: string) => ShopState
  mintSessionToken: (shopDomain: string, opts?: { expiresInSeconds?: number; secret?: string }) => string
  /** Queue raw HTTP failures for the next GraphQL requests to a shop. */
  failNext: (shopDomain: string, ...failures: Failure[]) => void
  expireAccessTokens: (shopDomain: string) => void
  revokeScope: (shopDomain: string, scope: string) => void
  deliverWebhook: (
    shopDomain: string,
    topic: string,
    overrides: Record<string, unknown>,
    opts?: { webhookId?: string; secret?: string },
  ) => Promise<{ status: number; webhookId: string }>
  /** Requests the fake answered, after authentication, validation and the cost check. */
  requests: { shop: string; path: string; operation?: string; version?: string }[]
  tokenRequests: { shop: string; grantType: string; status: number }[]
  /** Requests refused because the shop's cost bucket was too low; not included in `requests`. */
  throttled: { shop: string; operation?: string }[]
  /** GraphQL requests refused because the token was missing, wrong or expired. */
  unauthorized: number
  close: () => Promise<void>
}

const DEFAULT_SCOPES = ['read_products', 'read_content', 'write_content']

function countObjects(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + countObjects(v), 0)
  if (value && typeof value === 'object') return 1 + Object.values(value).reduce((n: number, v) => n + countObjects(v), 0)
  return 0
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(body))
}

function verifyJwt(token: string, secret: string): Record<string, unknown> | undefined {
  const [header, payload, signature] = token.split('.')
  if (!header || !payload || !signature) return undefined
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  if (expected !== signature) return undefined
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
}

export async function startFakeShopify(options: FakeShopifyOptions): Promise<FakeShopify> {
  const shops = new Map<string, ShopState>()
  const failures = new Map<string, Failure[]>()
  const requests: FakeShopify['requests'] = []
  const tokenRequests: FakeShopify['tokenRequests'] = []
  const throttled: FakeShopify['throttled'] = []
  let unauthorized = 0
  const schema = pinnedSchema()
  const documents = new Map<string, DocumentNode>()
  const now = () => Date.now()

  const tokenEndpoint = async (shop: ShopState, req: IncomingMessage, res: ServerResponse) => {
    const raw = await readBody(req)
    const params: Record<string, string> = req.headers['content-type']?.includes('json')
      ? JSON.parse(raw)
      : Object.fromEntries(new URLSearchParams(raw))
    const reply = (status: number, body: unknown) => {
      tokenRequests.push({ shop: shop.domain, grantType: params.grant_type ?? '', status })
      return send(res, status, body)
    }
    if (params.client_id !== options.clientId || params.client_secret !== options.clientSecret) {
      return reply(400, { error: 'invalid_client' })
    }
    const issue = () => {
      const access = { value: randomToken('shpat_'), expiresAt: now() + ACCESS_TOKEN_SECONDS * 1000 }
      const refresh = { value: randomToken('shprt_'), expiresAt: now() + REFRESH_TOKEN_SECONDS * 1000 }
      shop.accessTokens.push(access)
      for (const r of shop.refreshTokens) r.retired = true
      shop.refreshTokens.push(refresh)
      shop.installed = true
      return reply(200, {
        access_token: access.value,
        expires_in: ACCESS_TOKEN_SECONDS,
        refresh_token: refresh.value,
        refresh_token_expires_in: REFRESH_TOKEN_SECONDS,
      })
    }

    if (params.grant_type === 'urn:ietf:params:oauth:grant-type:token-exchange') {
      const claims = params.subject_token ? verifyJwt(params.subject_token, options.clientSecret) : undefined
      const seconds = Math.floor(now() / 1000)
      if (
        !claims ||
        params.subject_token_type !== 'urn:ietf:params:oauth:token-type:id_token' ||
        claims.aud !== options.clientId ||
        claims.dest !== `https://${shop.domain}` ||
        Number(claims.exp) <= seconds ||
        Number(claims.nbf) > seconds
      ) {
        return reply(400, { error: 'invalid_subject_token' })
      }
      return issue()
    }
    if (params.grant_type === 'refresh_token') {
      const token = shop.refreshTokens.find((t) => t.value === params.refresh_token)
      if (!token || token.retired || token.expiresAt <= now()) return reply(401, { error: 'invalid_request' })
      return issue()
    }
    return reply(400, { error: 'unsupported_grant_type' })
  }

  const graphqlEndpoint = async (shop: ShopState, version: string, req: IncomingMessage, res: ServerResponse) => {
    // Shopify answers an unavailable version with the oldest one it still serves; the fake serves only the pinned one.
    const versionHeader = { 'x-shopify-api-version': PINNED_VERSION }
    const queued = failures.get(shop.domain)?.shift()
    if (queued) return send(res, queued.status, queued.body, versionHeader)

    const token = req.headers['x-shopify-access-token']
    const valid = shop.installed && shop.accessTokens.some((t) => t.value === token && t.expiresAt > now())
    if (!valid) {
      unauthorized++
      return send(res, 401, { errors: 'Unauthorized' }, versionHeader)
    }

    const body = JSON.parse(await readBody(req)) as { query: string; variables?: Record<string, unknown> }
    let document = documents.get(body.query)
    if (!document) {
      try {
        document = parse(body.query)
      } catch (error) {
        return send(res, 200, { errors: [{ message: (error as Error).message }] }, versionHeader)
      }
      const errors = validate(schema, document, specifiedRules)
      if (errors.length) return send(res, 200, { errors: errors.map((e) => e.toJSON()) }, versionHeader)
      documents.set(body.query, document)
    }
    const operation = document.definitions.find((d) => d.kind === 'OperationDefinition')
    const operationName = operation && 'name' in operation ? operation.name?.value : undefined

    const variables = body.variables ?? {}
    const cost = requestedCost(schema, document, variables)
    if (cost > SINGLE_QUERY_MAX) {
      return send(res, 200, {
        errors: [{
          message: `Query cost is ${cost}, which exceeds the single query max cost limit (${SINGLE_QUERY_MAX}).`,
          extensions: { code: 'MAX_COST_EXCEEDED', cost, maxCost: SINGLE_QUERY_MAX },
        }],
      }, versionHeader)
    }
    const elapsed = (now() - shop.bucket.updatedAt) / 1000
    shop.bucket.available = Math.min(BUCKET_MAX, shop.bucket.available + elapsed * RESTORE_PER_SECOND)
    shop.bucket.updatedAt = now()
    const throttleStatus = () => ({
      maximumAvailable: BUCKET_MAX,
      currentlyAvailable: Math.floor(shop.bucket.available),
      restoreRate: RESTORE_PER_SECOND,
    })
    if (cost > shop.bucket.available) {
      throttled.push({ shop: shop.domain, operation: operationName })
      return send(res, 200, {
        errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
        extensions: { cost: { requestedQueryCost: cost, actualQueryCost: null, throttleStatus: throttleStatus() } },
      }, versionHeader)
    }
    shop.bucket.available -= cost
    requests.push({ shop: shop.domain, path: req.url ?? '', operation: operationName, version })

    const root = resolvers(shop, { now, listLagMs: options.listLagMs ?? 0 }) as Record<string, (args: never) => unknown>
    const guarded: Record<string, unknown> = {}
    for (const field of rootFieldNames(document)) {
      const scope = ROOT_FIELD_SCOPES[field]
      if (scope === undefined) {
        guarded[field] = () => { throw new GraphQLError(`The fake does not serve ${field}; add it with a recording`) }
      } else if (scope && !shop.grantedScopes.includes(scope)) {
        guarded[field] = () => { throw accessDenied(field, scope) }
      } else {
        guarded[field] = root[field]
      }
    }
    const result = await execute({ schema, document, rootValue: guarded, variableValues: variables })
    // Shopify charges what the answer actually cost and refunds the rest of the reservation.
    // How it counts is not published; one point per object returned is the fake's stand-in.
    const actual = Math.min(cost, countObjects(result.data))
    shop.bucket.available = Math.min(BUCKET_MAX, shop.bucket.available + (cost - actual))
    send(res, 200, {
      ...(result.errors ? { errors: result.errors.map((e) => e.toJSON()) } : {}),
      data: result.data ?? null,
      extensions: { cost: { requestedQueryCost: cost, actualQueryCost: actual, throttleStatus: throttleStatus() } },
    }, versionHeader)
  }

  const server = createServer(async (req, res) => {
    try {
      const match = /^\/([^/]+)\/admin\/(?:oauth\/access_token|api\/([^/]+)\/graphql\.json)$/.exec(req.url ?? '')
      const shop = match ? shops.get(match[1]!) : undefined
      if (!match || !shop || req.method !== 'POST') return send(res, 404, { errors: 'Not Found' })
      if (match[2]) return await graphqlEndpoint(shop, match[2], req, res)
      return await tokenEndpoint(shop, req, res)
    } catch (error) {
      send(res, 500, { errors: 'An unexpected error occurred', detail: String(error) })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const get = (domain: string) => {
    const shop = shops.get(domain)
    if (!shop) throw new Error(`fake Shopify has no shop ${domain}`)
    return shop
  }

  return {
    url,
    baseUrlFor: (domain) => `${url}/${domain}`,
    addShop: (fixture, scopes = DEFAULT_SCOPES) => {
      const state = loadFixture(fixture, scopes)
      shops.set(state.domain, state)
      return state
    },
    shop: get,
    mintSessionToken: (domain, { expiresInSeconds = 60, secret = options.clientSecret } = {}) => {
      const seconds = Math.floor(now() / 1000)
      const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
      const payload = base64url(JSON.stringify({
        iss: `https://${domain}/admin`,
        dest: `https://${domain}`,
        aud: options.clientId,
        sub: '42',
        exp: seconds + expiresInSeconds,
        nbf: seconds - 5,
        iat: seconds,
        jti: randomUUID(),
        sid: randomUUID(),
      }))
      const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
      return `${header}.${payload}.${signature}`
    },
    failNext: (domain, ...list) => {
      failures.set(domain, [...(failures.get(domain) ?? []), ...list])
    },
    expireAccessTokens: (domain) => {
      for (const t of get(domain).accessTokens) t.expiresAt = now() - 1000
    },
    revokeScope: (domain, scope) => {
      const shop = get(domain)
      shop.grantedScopes = shop.grantedScopes.filter((s) => s !== scope)
    },
    deliverWebhook: async (domain, topic, overrides, { webhookId = randomUUID(), secret = options.clientSecret } = {}) => {
      if (!options.webhookUrl) throw new Error('fake Shopify was started without a webhookUrl')
      const sample = webhookSamples[topic]
      if (!sample) throw new Error(`no published sample payload for ${topic}`)
      const body = JSON.stringify({ ...sample, ...overrides })
      const response = await fetch(options.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-shopify-topic': topic,
          'x-shopify-hmac-sha256': createHmac('sha256', secret).update(body).digest('base64'),
          'x-shopify-shop-domain': domain,
          'x-shopify-api-version': PINNED_VERSION,
          'x-shopify-webhook-id': webhookId,
          'x-shopify-event-id': randomUUID(),
          'x-shopify-triggered-at': new Date(now()).toISOString(),
        },
        body,
      })
      if (topic === 'app/uninstalled') get(domain).installed = false
      return { status: response.status, webhookId }
    },
    requests,
    tokenRequests,
    throttled,
    get unauthorized() {
      return unauthorized
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
