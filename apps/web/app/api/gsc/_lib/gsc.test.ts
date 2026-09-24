import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { ROUTES, routeKey } from '@sortiva/core'
import { redirectResponseSchema } from '@sortiva/core/api/schemas'
import type { GscConnectDeps, GscProvider, GscSite, GscTokens } from '@sortiva/core'
import { gscConns, ingestionJobs, jobSteps, makeGscConnectStore } from '@sortiva/db'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { createRun } from '@sortiva/jobs/runtime/steps'
import { MockPosthogCapture, TokenCipher } from '@sortiva/providers'
import { withAccount } from '../../auth/_lib/session'
import {
  makeGscCallbackHandler,
  makeGscPropertiesHandler,
  makeGscSelectPropertyHandler,
  makeGscSkipHandler,
  makeGscStartHandler,
} from './handlers'
import { createOAuthState } from './state'

/**
 * The connection flow end to end against a real database: what the merchant's
 * browser sends, what ends up in the connection row, and what happens to the
 * onboarding step they answered.
 */

const available = await databaseAvailable()

process.env.APP_URL ??= 'https://app.test'
process.env.AUTH_SECRET ??= 'test-secret-for-signing-oauth-state'
process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64')

/**
 * The contract's own entry for the connect button's endpoint. Looked up rather
 * than restated, so a change to what this endpoint promises fails here instead
 * of being noticed on a deployed server.
 */
const startRoute = ROUTES.find((route) => routeKey(route) === 'POST /api/gsc/oauth/start')
if (!startRoute) throw new Error('POST /api/gsc/oauth/start has left the route table')

function tokens(): GscTokens {
  return {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
  }
}

class FakeProvider implements GscProvider {
  exchanges = 0
  constructor(private readonly sites: readonly GscSite[] = []) {}
  authorizationUrl(input: { state: string; redirectUri: string }): string {
    return `https://google.test/consent?state=${encodeURIComponent(input.state)}&redirect_uri=${encodeURIComponent(input.redirectUri)}`
  }
  async exchangeCode(): Promise<GscTokens> {
    this.exchanges += 1
    return tokens()
  }
  async refresh(): Promise<GscTokens> {
    return tokens()
  }
  async revoke(): Promise<void> {
    throw new Error('not used here')
  }
  async listSites(): Promise<readonly GscSite[]> {
    return this.sites
  }
  async searchAnalytics(): Promise<never> {
    throw new Error('not used here')
  }
}

describe.skipIf(!available)('connecting Search Console', () => {
  let harness: TestDb
  let accountId: string
  let capture: MockPosthogCapture
  let provider: FakeProvider
  let backfills: string[]

  beforeAll(async () => {
    harness = await setupTestDb('web_gsc_connect')
    // Creating a database and applying every migration is slower than vitest's
    // default hook budget when the machine is busy.
  }, 60_000)

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    accountId = await insertAccount(harness.pool, `gsc-${Math.random().toString(36).slice(2)}@example.com`)
    await harness.pool.query(
      `INSERT INTO domains (account_id, domain_normalized, state) VALUES ($1, $2, 'ingesting')`,
      [accountId, 'example.com'],
    )
    capture = new MockPosthogCapture()
    provider = new FakeProvider([
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
      { siteUrl: 'https://a-client-of-theirs.com/', permissionLevel: 'siteFullUser' },
    ])
    backfills = []
  })

  function deps(): GscConnectDeps {
    return {
      store: makeGscConnectStore({
        database: harness.db,
        enqueueBackfill: async (_database, id) => {
          backfills.push(id)
        },
      }),
      provider,
      codec: new TokenCipher(),
      capture,
    }
  }

  const as = (handler: Parameters<typeof withAccount>[0]) => withAccount(handler, async () => accountId)

  it('sends the merchant to Google with a state bound to their account', async () => {
    const response = await as(makeGscStartHandler({ deps: deps() }))(
      new Request('https://app.test/api/gsc/oauth/start', { method: 'POST' }),
      {},
    )
    expect(
      startRoute.response,
      'the contract no longer declares this endpoint as a plain redirect answer, so this test is ' +
        'checking the wrong shape',
    ).toBe(redirectResponseSchema)
    // Parsed with the declaration itself rather than with a field name written
    // out here: a name written in two places is a name that can drift.
    const body = redirectResponseSchema.parse(await response.json())
    const url = new URL(body.url)
    expect(url.searchParams.get('state')).toContain(accountId)
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/api/gsc/oauth/callback')
  })

  it('refuses a callback whose state was not signed for this account', async () => {
    const somebodyElse = createOAuthState('00000000-0000-4000-8000-000000000000', 'connections')
    const response = await as(makeGscCallbackHandler({ deps: deps() }))(
      new Request(`https://app.test/api/gsc/oauth/callback?code=abc&state=${somebodyElse}`),
      {},
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('gsc=failed')
    expect(provider.exchanges).toBe(0)
    const rows = await harness.db.select().from(gscConns).where(eq(gscConns.accountId, accountId))
    expect(rows).toHaveLength(0)
  })

  it('treats a refusal on Google’s consent screen as an answer, not an error', async () => {
    const response = await as(makeGscCallbackHandler({ deps: deps() }))(
      new Request('https://app.test/api/gsc/oauth/callback?error=access_denied'),
      {},
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('gsc=denied')
    expect(provider.exchanges).toBe(0)
  })

  it('stores the grant encrypted, with no property yet', async () => {
    await connect()

    const [row] = await harness.db.select().from(gscConns).where(eq(gscConns.accountId, accountId))
    expect(row!.property).toBe('')
    // What is on disk is ciphertext, not the merchant's Google token.
    expect(row!.tokens).not.toContain('access')
    expect(row!.tokens.startsWith('v1.')).toBe(true)
  })

  it('lists every property, flagged, so the picker can explain a mismatch', async () => {
    await connect()
    const response = await as(makeGscPropertiesHandler({ deps: deps() }))(
      new Request('https://app.test/api/gsc/properties'),
      {},
    )
    const body = (await response.json()) as {
      properties: { siteUrl: string; matchesClaimedDomain: boolean }[]
    }
    expect(body.properties).toEqual([
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner', matchesClaimedDomain: true },
      {
        siteUrl: 'https://a-client-of-theirs.com/',
        permissionLevel: 'siteFullUser',
        matchesClaimedDomain: false,
      },
    ])
  })

  it('rejects a property for a different website, and writes nothing', async () => {
    await connect()
    const response = await selectProperty('sc-domain:a-client-of-theirs.com')

    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('gsc_property_mismatch')
    expect(body.error.message).toContain('example.com')

    const [row] = await harness.db.select().from(gscConns).where(eq(gscConns.accountId, accountId))
    expect(row!.property).toBe('')
    expect(backfills).toEqual([])
  })

  it('accepts the store’s own property, finishes the step and queues the history import', async () => {
    const { jobId } = await createRun(harness.db, accountId, 'run-1')
    await connect()

    const response = await selectProperty('sc-domain:example.com')
    expect(response.status).toBe(200)

    const [row] = await harness.db.select().from(gscConns).where(eq(gscConns.accountId, accountId))
    expect(row!.property).toBe('sc-domain:example.com')
    expect(row!.connectedAt).toBeInstanceOf(Date)

    const steps = await harness.db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId))
    expect(steps.find((s) => s.step === 'gsc_connect')!.state).toBe('succeeded')
    expect(backfills).toEqual([accountId])
    expect(capture.events.map((e) => e.event)).toContain('gsc_connected')
  })

  it('records a skip on the step, and leaves the rest of onboarding alone', async () => {
    const { jobId } = await createRun(harness.db, accountId, 'run-1')

    const response = await as(makeGscSkipHandler({ deps: deps() }))(
      new Request('https://app.test/api/gsc/skip', { method: 'POST' }),
      {},
    )
    expect(response.status).toBe(200)

    const steps = await harness.db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId))
    expect(steps.find((s) => s.step === 'gsc_connect')!.state).toBe('skipped')
    // The step every merchant has to reach is untouched and still waiting.
    expect(steps.find((s) => s.step === 'awaiting_confirmation')!.state).toBe('pending')

    // And nothing anywhere was flagged: running without search data is worked
    // out from the absence of a connection row.
    const conns = await harness.db.select().from(gscConns).where(eq(gscConns.accountId, accountId))
    expect(conns).toHaveLength(0)
  })

  it('answering after the run has moved on changes nothing and fails nothing', async () => {
    const { jobId } = await createRun(harness.db, accountId, 'run-1')
    await harness.db
      .update(ingestionJobs)
      .set({ status: 'succeeded' })
      .where(eq(ingestionJobs.id, jobId))

    await connect()
    const response = await selectProperty('sc-domain:example.com')
    expect(response.status).toBe(200)

    // The connection is made — that is the part that matters — while the step
    // of a finished run stays as it was.
    const [row] = await harness.db.select().from(gscConns).where(eq(gscConns.accountId, accountId))
    expect(row!.property).toBe('sc-domain:example.com')
    const steps = await harness.db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId))
    expect(steps.find((s) => s.step === 'gsc_connect')!.state).toBe('pending')
  })

  async function connect(): Promise<void> {
    const state = createOAuthState(accountId, 'connections')
    const response = await as(makeGscCallbackHandler({ deps: deps() }))(
      new Request(`https://app.test/api/gsc/oauth/callback?code=abc&state=${state}`),
      {},
    )
    expect(response.headers.get('location')).toContain('gsc=granted')
  }

  function selectProperty(siteUrl: string): Promise<Response> {
    return as(makeGscSelectPropertyHandler({ deps: deps() }))(
      new Request('https://app.test/api/gsc/property', {
        method: 'POST',
        body: JSON.stringify({ siteUrl }),
      }),
      {},
    )
  }
})

/**
 * Where a merchant ends up, and whether the connection is actually made.
 *
 * The defect: every merchant was returned to Settings → Connections, which had
 * no property picker on it. The screen said "connected" while no property had
 * been chosen, no history import had been queued, and the account stayed on
 * limited data — a connection that looked finished and had not started.
 *
 * Both journeys are driven here through the real handlers against a real
 * database, because the thing that was broken is where the browser is sent, and
 * a test of either handler alone would have passed throughout.
 */
describe.skipIf(!available)('coming back from Google', () => {
  let harness: TestDb
  let accountId: string
  let provider: FakeProvider
  let capture: MockPosthogCapture
  let backfills: string[]

  beforeAll(async () => {
    harness = await setupTestDb('gsc_return')
  })

  afterAll(async () => {
    await harness?.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    accountId = await insertAccount(harness.pool, `ret-${Math.random().toString(36).slice(2)}@example.com`)
    await harness.pool.query(
      `INSERT INTO domains (account_id, domain_normalized, state) VALUES ($1, $2, 'ingesting')`,
      [accountId, 'example.com'],
    )
    capture = new MockPosthogCapture()
    provider = new FakeProvider([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }])
    backfills = []
  })

  function deps(): GscConnectDeps {
    return {
      store: makeGscConnectStore({
        database: harness.db,
        enqueueBackfill: async (_database, id) => {
          backfills.push(id)
        },
      }),
      provider,
      codec: new TokenCipher(),
      capture,
    }
  }

  const as = (handler: Parameters<typeof withAccount>[0]) => withAccount(handler, async () => accountId)

  /** The whole journey: press connect on one screen, consent, come back, choose the property. */
  async function journey(from: 'dashboard' | 'connections'): Promise<string> {
    const started = await as(makeGscStartHandler({ deps: deps() }))(
      new Request('https://app.test/api/gsc/oauth/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnTo: from }),
      }),
      {},
    )
    const consent = new URL(((await started.json()) as { url: string }).url)
    const state = consent.searchParams.get('state')!

    const back = await as(makeGscCallbackHandler({ deps: deps() }))(
      new Request(`https://app.test/api/gsc/oauth/callback?code=abc&state=${encodeURIComponent(state)}`),
      {},
    )
    expect(back.status).toBe(302)
    return back.headers.get('location')!
  }

  /** What the picker on whichever screen they landed on then does. */
  async function chooseProperty(): Promise<void> {
    const chosen = await as(makeGscSelectPropertyHandler({ deps: deps() }))(
      new Request('https://app.test/api/gsc/property', {
        method: 'POST',
        body: JSON.stringify({ siteUrl: 'sc-domain:example.com' }),
      }),
      {},
    )
    expect(chosen.status).toBe(200)
  }

  it('finishes on the dashboard for a merchant who started there, with the property stored', async () => {
    const landed = await journey('dashboard')
    expect(landed).toContain('/dashboard?gsc=granted')

    await chooseProperty()
    const [row] = await harness.db.select().from(gscConns).where(eq(gscConns.accountId, accountId))
    expect(row!.property).toBe('sc-domain:example.com')
    expect(backfills).toEqual([accountId])
  })

  it('finishes on Settings for a merchant who started there, with the property stored', async () => {
    const landed = await journey('connections')
    expect(landed).toContain('/settings/connections?gsc=granted')

    await chooseProperty()
    const [row] = await harness.db.select().from(gscConns).where(eq(gscConns.accountId, accountId))
    expect(row!.property).toBe('sc-domain:example.com')
    expect(backfills).toEqual([accountId])
  })

  it('refuses to be sent anywhere but those two, whatever the caller asks for', async () => {
    const started = await as(makeGscStartHandler({ deps: deps() }))(
      new Request('https://app.test/api/gsc/oauth/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnTo: 'https://evil.example/steal' }),
      }),
      {},
    )
    const consent = new URL(((await started.json()) as { url: string }).url)
    const state = consent.searchParams.get('state')!
    expect(state).not.toContain('evil.example')

    const back = await as(makeGscCallbackHandler({ deps: deps() }))(
      new Request(`https://app.test/api/gsc/oauth/callback?code=abc&state=${encodeURIComponent(state)}`),
      {},
    )
    expect(back.headers.get('location')).toContain('/settings/connections?gsc=granted')
  })

  it('refuses a state whose destination was tampered with, rather than honouring it', async () => {
    const started = await as(makeGscStartHandler({ deps: deps() }))(
      new Request('https://app.test/api/gsc/oauth/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnTo: 'dashboard' }),
      }),
      {},
    )
    const consent = new URL(((await started.json()) as { url: string }).url)
    const forged = consent.searchParams.get('state')!.replace('.dashboard.', '.connections.')

    const back = await as(makeGscCallbackHandler({ deps: deps() }))(
      new Request(`https://app.test/api/gsc/oauth/callback?code=abc&state=${encodeURIComponent(forged)}`),
      {},
    )
    // The signature covers the destination, so editing it invalidates the whole
    // state rather than redirecting somewhere else.
    expect(back.headers.get('location')).toContain('gsc=failed')
    expect(provider.exchanges).toBe(0)
  })
})
