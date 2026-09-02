import { describe, expect, it } from 'vitest'
import type { AnalyticsEvent } from '../contracts/analytics'
import type { GscProvider, GscSite, GscTokens } from '../contracts/gsc'
import {
  chooseGscProperty,
  completeGscGrant,
  encodeGscTokens,
  listGscProperties,
  skipGscConnect,
  startGscConnect,
  type GscConnectDeps,
  type GscConnectStore,
  type GscConnectionRecord,
  type GscTokenCodec,
} from './connect'
import { isLimitedIntelligence } from './connection'

/** Records what was sent to analytics, so a test can look at it. */
class RecordingCapture {
  readonly events: AnalyticsEvent[] = []
  capture(event: AnalyticsEvent): void {
    this.events.push(event)
  }
}

const codec: GscTokenCodec = {
  encrypt: (value) => `enc:${value}`,
  decrypt: (value) => value.slice('enc:'.length),
}

function tokens(): GscTokens {
  return {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
  }
}

class FakeStore implements GscConnectStore {
  domain: string | null = 'example.com'
  conn: GscConnectionRecord | null = null
  connectStep: 'pending' | 'succeeded' | 'skipped' = 'pending'
  backfills: string[] = []
  /** Set to make `selectProperty` behave as though the grant vanished under us. */
  grantVanished = false

  async claimedDomain(): Promise<string | null> {
    return this.domain
  }
  async connection(): Promise<GscConnectionRecord | null> {
    return this.conn
  }
  async saveGrant(_accountId: string, stored: string): Promise<void> {
    this.conn = { property: '', tokens: stored, invalidatedAt: null }
  }
  async selectProperty(_accountId: string, property: string): Promise<boolean> {
    if (this.grantVanished || !this.conn) return false
    this.conn = { ...this.conn, property }
    return true
  }
  async completeConnectStep(): Promise<void> {
    this.connectStep = 'succeeded'
  }
  async skipConnectStep(): Promise<void> {
    this.connectStep = 'skipped'
  }
  async enqueueBackfill(accountId: string): Promise<void> {
    this.backfills.push(accountId)
  }
}

class FakeProvider implements GscProvider {
  constructor(private readonly sites: readonly GscSite[] = []) {}
  authorizationUrl(input: { state: string; redirectUri: string }): string {
    return `https://google.test/consent?state=${input.state}`
  }
  async exchangeCode(): Promise<GscTokens> {
    return tokens()
  }
  async refresh(): Promise<GscTokens> {
    return tokens()
  }
  async listSites(): Promise<readonly GscSite[]> {
    return this.sites
  }
  async searchAnalytics(): Promise<never> {
    throw new Error('not used here')
  }
}

function setup(sites: readonly GscSite[] = []): {
  deps: GscConnectDeps
  store: FakeStore
  capture: RecordingCapture
} {
  const store = new FakeStore()
  const capture = new RecordingCapture()
  return {
    store,
    capture,
    deps: {
      store,
      provider: new FakeProvider(sites),
      codec,
      capture,
      now: () => new Date('2026-09-02T10:00:00Z'),
    },
  }
}

describe('starting the connection', () => {
  it('sends the merchant to Google carrying the state we signed', () => {
    const { deps } = setup()
    const { redirectUrl } = startGscConnect(deps, {
      state: 'signed-state',
      redirectUri: 'https://app.test/api/gsc/oauth/callback',
    })
    expect(redirectUrl).toContain('signed-state')
  })

  it('a granted permission is not yet a connection', async () => {
    const { deps, store } = setup()
    await completeGscGrant(deps, {
      accountId: 'acct-1',
      code: 'code',
      redirectUri: 'https://app.test/cb',
    })

    expect(store.conn?.property).toBe('')
    expect(isLimitedIntelligence(store.conn)).toBe(true)
    expect(store.connectStep).toBe('pending')
    expect(store.backfills).toEqual([])
  })
})

describe('the property picker', () => {
  it('returns every property, each flagged for whether it is this store', async () => {
    const { deps, store } = setup([
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
      { siteUrl: 'https://a-client-of-theirs.com/', permissionLevel: 'siteFullUser' },
    ])
    store.conn = { property: '', tokens: encodeGscTokens(codec, tokens()), invalidatedAt: null }

    const result = await listGscProperties(deps, { accountId: 'acct-1' })
    expect(result.kind).toBe('properties')
    if (result.kind !== 'properties') throw new Error('unreachable')
    expect(result.properties.map((p) => p.matchesClaimedDomain)).toEqual([true, false])
  })

  it('has nothing to show before Google has granted anything', async () => {
    const { deps } = setup()
    expect(await listGscProperties(deps, { accountId: 'acct-1' })).toEqual({ kind: 'not_granted' })
  })
})

describe('choosing a property', () => {
  it('refuses a property for a different website', async () => {
    const { deps, store, capture } = setup()
    store.conn = { property: '', tokens: encodeGscTokens(codec, tokens()), invalidatedAt: null }

    const result = await chooseGscProperty(deps, {
      accountId: 'acct-1',
      siteUrl: 'sc-domain:a-client-of-theirs.com',
    })

    expect(result).toEqual({ kind: 'host_mismatch', claimedDomain: 'example.com' })
    // Nothing at all happened: no property, no step, no import, no event.
    expect(store.conn.property).toBe('')
    expect(store.connectStep).toBe('pending')
    expect(store.backfills).toEqual([])
    expect(capture.events).toHaveLength(0)
  })

  it('accepts a property under the claimed domain, and starts the history import', async () => {
    const { deps, store } = setup()
    store.conn = { property: '', tokens: encodeGscTokens(codec, tokens()), invalidatedAt: null }

    const result = await chooseGscProperty(deps, {
      accountId: 'acct-1',
      siteUrl: 'https://shop.example.com/',
    })

    expect(result).toEqual({ kind: 'selected', property: 'https://shop.example.com/' })
    expect(store.connectStep).toBe('succeeded')
    expect(store.backfills).toEqual(['acct-1'])
    expect(isLimitedIntelligence(store.conn)).toBe(false)
  })

  it('reports the connection rather than the merchant’s addresses to analytics', async () => {
    const { deps, store, capture } = setup()
    store.conn = { property: '', tokens: encodeGscTokens(codec, tokens()), invalidatedAt: null }

    await chooseGscProperty(deps, { accountId: 'acct-1', siteUrl: 'sc-domain:example.com' })

    expect(capture.events).toHaveLength(1)
    expect(capture.events[0]!.event).toBe('gsc_connected')
    expect(capture.events[0]!.properties).toEqual({ property_kind: 'domain' })
    expect(JSON.stringify(capture.events[0])).not.toContain('sc-domain:example.com')
  })

  it('stops rather than writing a property against a grant that has gone', async () => {
    const { deps, store } = setup()
    store.conn = { property: '', tokens: encodeGscTokens(codec, tokens()), invalidatedAt: null }
    store.grantVanished = true

    const result = await chooseGscProperty(deps, {
      accountId: 'acct-1',
      siteUrl: 'sc-domain:example.com',
    })

    expect(result).toEqual({ kind: 'not_granted' })
    expect(store.backfills).toEqual([])
  })
})

describe('skipping', () => {
  it('records the answer on the onboarding step and writes no flag anywhere', async () => {
    const { deps, store } = setup()

    await skipGscConnect(deps, { accountId: 'acct-1' })

    expect(store.connectStep).toBe('skipped')
    // The account now runs without search data — worked out from the absence of
    // a connection, not from anything the skip stored.
    expect(store.conn).toBeNull()
    expect(isLimitedIntelligence(store.conn)).toBe(true)
  })

  it('a merchant who skips and later connects is no longer limited', async () => {
    const { deps, store } = setup()
    await skipGscConnect(deps, { accountId: 'acct-1' })

    await completeGscGrant(deps, {
      accountId: 'acct-1',
      code: 'code',
      redirectUri: 'https://app.test/cb',
    })
    await chooseGscProperty(deps, { accountId: 'acct-1', siteUrl: 'sc-domain:example.com' })

    expect(isLimitedIntelligence(store.conn)).toBe(false)
  })
})
