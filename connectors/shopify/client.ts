import { AccessLostError, PermissionLostError, TransientStoreError } from '../types.ts'
import type { ShopifyAppConfig, StoredTokens } from './tokens.ts'

type GraphQLError = { message: string; extensions?: { code?: string; requiredAccess?: string } }
type GraphQLResponse<T> = {
  data?: T | null
  errors?: GraphQLError[] | string
  extensions?: { cost?: { requestedQueryCost: number; throttleStatus: { currentlyAvailable: number; restoreRate: number } } }
}

export type ClientOptions = {
  maxAttempts?: number
  baseDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** Sends documents from queries.ts to one shop's Admin API, handling tokens, throttling and errors. */
export class ShopifyClient {
  /** The version Shopify says it answered with; differs from the pinned one only if Shopify fell forward. */
  lastApiVersion: string | null = null
  private readonly maxAttempts: number
  private readonly baseDelayMs: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    private readonly app: ShopifyAppConfig,
    readonly shopDomain: string,
    private readonly tokens: StoredTokens,
    options: ClientOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 5
    this.baseDelayMs = options.baseDelayMs ?? 500
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  async request<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
    let refreshedAfter401 = false
    for (let attempt = 1; ; attempt++) {
      const token = await this.tokens.accessToken()
      let res: Response
      try {
        res = await fetch(`${this.app.baseUrlFor(this.shopDomain)}/admin/api/${this.app.apiVersion}/graphql.json`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
          body: JSON.stringify({ query: document, variables }),
        })
      } catch (error) {
        if (attempt >= this.maxAttempts) throw new TransientStoreError(`Shopify unreachable: ${(error as Error).message}`)
        await this.sleep(this.backoff(attempt))
        continue
      }
      this.lastApiVersion = res.headers.get('x-shopify-api-version')

      if (res.status === 401) {
        // A token can die before its stated expiry (reinstall, revocation); one forced renewal tells the two apart.
        if (refreshedAfter401) throw new AccessLostError(`Shopify rejected a freshly renewed token for ${this.shopDomain}`)
        refreshedAfter401 = true
        await this.tokens.refresh(true)
        continue
      }
      if (res.status === 402 || res.status === 423) throw new AccessLostError(`${this.shopDomain} is unavailable (HTTP ${res.status})`)
      if (res.status === 403) throw new PermissionLostError('unknown', `Shopify refused access to ${this.shopDomain} (HTTP 403)`)
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.maxAttempts) throw new TransientStoreError(`Shopify answered HTTP ${res.status} ${attempt} times`)
        await this.sleep(this.backoff(attempt))
        continue
      }
      if (!res.ok) throw new Error(`Shopify answered HTTP ${res.status} for ${this.shopDomain}`)

      const body = (await res.json()) as GraphQLResponse<T>
      const errors = typeof body.errors === 'string' ? [{ message: body.errors }] : (body.errors ?? [])
      const throttled = errors.find((e) => e.extensions?.code === 'THROTTLED')
      if (throttled) {
        if (attempt >= this.maxAttempts) throw new TransientStoreError(`still throttled after ${attempt} attempts`)
        const cost = body.extensions?.cost
        const wait = cost
          ? Math.ceil(((cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable) / cost.throttleStatus.restoreRate) * 1000)
          : this.backoff(attempt)
        await this.sleep(Math.max(wait, 50))
        continue
      }
      const denied = errors.find((e) => e.extensions?.code === 'ACCESS_DENIED')
      if (denied) {
        const scope = /`(\w+)`/.exec(denied.extensions?.requiredAccess ?? denied.message)?.[1] ?? 'unknown'
        throw new PermissionLostError(scope, denied.message)
      }
      if (errors.length) {
        if (errors.some((e) => e.extensions?.code === 'INTERNAL_SERVER_ERROR') && attempt < this.maxAttempts) {
          await this.sleep(this.backoff(attempt))
          continue
        }
        throw new Error(`Shopify GraphQL errors: ${errors.map((e) => e.message).join('; ')}`)
      }
      return body.data as T
    }
  }

  private backoff(attempt: number): number {
    return this.baseDelayMs * 2 ** (attempt - 1)
  }
}
