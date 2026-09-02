import { describe, expect, it } from 'vitest'
import { resolveAttribution, type AnalyticsEvent } from '../contracts/analytics'
import { accountResponseSchema } from '../api/schemas'
import { provisionAccount, SIGNUP_COMPLETED_EVENT, type AccountStore } from './provisioning'
import { buildAccountView, SERVICE_PAUSED_FLAGS } from './view'

/**
 * Records captures through the production attribution rules, so an
 * assertion about groups is an assertion about what PostHog would receive.
 */
function recorder() {
  const events: { event: string; groups: Record<string, string>; properties: Record<string, unknown> }[] = []
  return {
    events,
    capture(event: AnalyticsEvent) {
      const resolved = resolveAttribution(event.attribution)
      events.push({
        event: event.event,
        groups: resolved.groups,
        properties: { ...resolved.properties, ...(event.properties ?? {}) },
      })
    },
    of(name: string) {
      return events.filter((e) => e.event === name)
    },
  }
}

/** An in-memory stand-in for the `accounts` table's unique email index. */
function memoryStore(): AccountStore & { creates: number } {
  const byEmail = new Map<string, string>()
  let creates = 0
  return {
    get creates() {
      return creates
    },
    async createOrFindByEmail(email: string) {
      const existing = byEmail.get(email)
      if (existing) return { accountId: existing, created: false }
      const accountId = `acct_${byEmail.size + 1}`
      byEmail.set(email, accountId)
      creates += 1
      return { accountId, created: true }
    },
  }
}

describe('provisionAccount (main §4.1, §14.7)', () => {
  it('creates the account row on first sign-in and captures signup_completed', async () => {
    const store = memoryStore()
    const capture = recorder()

    const result = await provisionAccount({ store, capture }, {
      email: 'founder@example.com',
      provider: 'google',
    })

    expect(result.created).toBe(true)
    expect(store.creates).toBe(1)
    expect(capture.of(SIGNUP_COMPLETED_EVENT)).toHaveLength(1)
    expect(capture.of(SIGNUP_COMPLETED_EVENT)[0]!.properties.provider).toBe('google')
  })

  it('does not fire signup_completed for a returning sign-in', async () => {
    const store = memoryStore()
    const capture = recorder()
    const deps = { store, capture }

    const first = await provisionAccount(deps, { email: 'founder@example.com', provider: 'google' })
    const second = await provisionAccount(deps, { email: 'founder@example.com', provider: 'google' })

    expect(second.accountId).toBe(first.accountId)
    expect(second.created).toBe(false)
    expect(store.creates).toBe(1)
    expect(capture.of(SIGNUP_COMPLETED_EVENT)).toHaveLength(1)
  })

  it('treats email as the identity, so Google and email sign-in are one account', async () => {
    const store = memoryStore()
    const deps = { store }

    const viaGoogle = await provisionAccount(deps, { email: 'Founder@Example.com ', provider: 'google' })
    const viaEmail = await provisionAccount(deps, { email: 'founder@example.com', provider: 'email' })

    expect(viaEmail.accountId).toBe(viaGoogle.accountId)
  })

  it('carries no domain group before a domain is claimed (main §14.7)', async () => {
    const capture = recorder()
    await provisionAccount({ store: memoryStore(), capture }, {
      email: 'founder@example.com',
      provider: 'google',
    })

    expect(capture.of(SIGNUP_COMPLETED_EVENT)[0]!.groups).toEqual({})
  })
})

describe('buildAccountView (main §4.3)', () => {
  const base = {
    accountId: '00000000-0000-4000-8000-000000000001',
    email: 'founder@example.com',
    domain: null,
    subscription: null,
    shopify: null,
    activeFlags: [] as string[],
  }

  it('reports domain: null for a signed-in account that has claimed nothing', () => {
    const view = buildAccountView(base)
    expect(view.domain).toBeNull()
    expect(view.subscription.status).toBe('none')
    expect(accountResponseSchema.safeParse(view).success).toBe(true)
  })

  it('reports the claimed domain and its ingestion state', () => {
    const view = buildAccountView({
      ...base,
      domain: { normalized: 'example.com', state: 'ingesting', platform: 'shopify' },
    })
    expect(view.domain).toEqual({ normalized: 'example.com', state: 'ingesting', platform: 'shopify' })
    expect(accountResponseSchema.safeParse(view).success).toBe(true)
  })

  it('distinguishes read-only Shopify from a write grant and from a dead token', () => {
    const read = buildAccountView({ ...base, shopify: { grantedScopes: ['read_products'], invalidatedAt: null } })
    const write = buildAccountView({
      ...base,
      shopify: { grantedScopes: ['read_products', 'write_content'], invalidatedAt: null },
    })
    const broken = buildAccountView({
      ...base,
      shopify: { grantedScopes: ['read_products'], invalidatedAt: new Date() },
    })

    expect(read.connections.shopify).toBe('read')
    expect(write.connections.shopify).toBe('read_write')
    expect(broken.connections.shopify).toBe('broken')
  })

  it('is paused only by the kill switches that stop this account working (main §14.5)', () => {
    for (const flag of SERVICE_PAUSED_FLAGS) {
      expect(buildAccountView({ ...base, activeFlags: [flag] }).servicePaused).toBe(true)
    }
    expect(buildAccountView({ ...base, activeFlags: ['global.pause_publishing'] }).servicePaused).toBe(false)
  })
})

describe('the Search Console badge turns itself off (T3.1)', () => {
  const base = {
    accountId: 'acct-1',
    email: 'merchant@example.com',
    domain: null,
    subscription: null,
    shopify: null,
    activeFlags: [] as string[],
  }

  it('says the account is running on limited data when nothing is connected', () => {
    expect(buildAccountView(base).limitedIntelligence).toBe(true)
    expect(buildAccountView({ ...base, searchConsole: null }).connections.searchConsole).toBe('none')
  })

  it('still says so when Google has granted access but no property is chosen', () => {
    const view = buildAccountView({
      ...base,
      searchConsole: { property: '', invalidatedAt: null },
    })
    expect(view.limitedIntelligence).toBe(true)
    expect(view.connections.searchConsole).toBe('none')
  })

  it('stops saying so the moment a property is chosen, with no flag to clear', () => {
    const view = buildAccountView({
      ...base,
      searchConsole: { property: 'sc-domain:example.com', invalidatedAt: null },
    })
    expect(view.limitedIntelligence).toBe(false)
    expect(view.connections.searchConsole).toBe('connected')
  })

  it('a dead permission asks for a reconnect rather than reviving the badge', () => {
    const view = buildAccountView({
      ...base,
      searchConsole: { property: 'sc-domain:example.com', invalidatedAt: new Date() },
    })
    expect(view.limitedIntelligence).toBe(false)
    expect(view.connections.searchConsole).toBe('broken')
  })
})
