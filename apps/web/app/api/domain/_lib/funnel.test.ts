import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DOMAIN_CLAIMED_EVENT, provisionAccount, SIGNUP_COMPLETED_EVENT } from '@sortiva/core'
import {
  TEST_DATABASE_URL,
  databaseAvailable,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { dispatchableSteps } from '@sortiva/jobs/runtime/steps'
import {
  TRUNCATE_QUEUE_SQL,
  installQueueSchema,
  type WorkerUtils,
} from '@sortiva/jobs/runtime/testing'
import { MockPosthogCapture } from '@sortiva/providers'
import { makeAccountRouteHandler } from '../../account/_lib/handler'
import { makeDbAccountStore } from '../../auth/_lib/provisioning'
import { withAccount } from '../../auth/_lib/session'
import { makeClaimHandler } from './handler'
import { makeDomainClaimStore } from './store'

/**
 * **The M1 exit gate.** One merchant walks the whole funnel — sign up, connect a
 * domain, land on the progress state — through the real route handlers, the
 * real session wrapper, the real repositories and a real Postgres. Only PostHog
 * is a double.
 *
 * There is no payment step. There used to be one between signing up and
 * claiming, and removing the purchase layer removed it; what a merchant now
 * meets after signing in is the dashboard, and what the dashboard reads is the
 * account response asserted below.
 *
 * It is not the browser test the card asks for: no screen exists to drive
 * (Lane F has not started, `packages/ui` holds only the M0 mock server). This
 * is the highest level that genuinely exists today — every HTTP contract the
 * screens will call, in order, against real state. See DECISIONS 2026-09-01
 * T1.4 and the T1.4 report.
 */

const available = await databaseAvailable()

const APP_URL = 'https://app.sortiva.test'

describe.skipIf(!available)('M1 funnel: signup → claim → progress', () => {
  let harness: TestDb
  let capture: MockPosthogCapture
  let workerUtils: WorkerUtils

  beforeAll(async () => {
    harness = await setupTestDb('web_m1_funnel')
    // Claiming a domain now asks the queue to start that store's onboarding,
    // and the queue's tables are installed by the worker rather than by our
    // migrations. In production the worker runs in the web server's own process
    // and installs them at start-up; nothing starts one here.
    const url = new URL(TEST_DATABASE_URL)
    url.pathname = `/${harness.databaseName}`
    workerUtils = await installQueueSchema(url.toString())
  })

  afterAll(async () => {
    await workerUtils?.release()
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    await harness.pool.query(TRUNCATE_QUEUE_SQL)
    capture = new MockPosthogCapture()
  })

  const session = (id: string) => async () => id

  it('walks a merchant from nothing to an ingesting domain', async () => {
    // ── 1. Signup ────────────────────────────────────────────────────────────
    const { accountId, created } = await provisionAccount(
      { store: makeDbAccountStore(harness.db), capture },
      { email: 'merchant@example.com', provider: 'google' },
    )
    expect(created).toBe(true)
    expect(capture.of(SIGNUP_COMPLETED_EVENT)).toHaveLength(1)

    // Being signed in is not a connected domain: the dashboard's empty state.
    const account = () => withAccount(makeAccountRouteHandler(harness.db), session(accountId))
    const afterSignup = await (await account()(get('/api/account'), undefined)).json()
    expect(afterSignup.domain).toBeNull()
    expect(afterSignup.subscription.status).toBe('none')

    // ── 2. Claim the domain ──────────────────────────────────────────────────
    const claim = withAccount(
      makeClaimHandler({
        deps: { store: makeDomainClaimStore({ database: harness.db }), capture },
      }),
      session(accountId),
    )
    const claimResponse = await claim(
      new Request(`${APP_URL}/api/domain/claim`, {
        method: 'POST',
        body: JSON.stringify({ domain: 'https://www.Acme-Supply.co.uk/collections/all' }),
      }),
      undefined,
    )
    expect(claimResponse.status).toBe(200)
    const claimed = await claimResponse.json()
    expect(claimed.normalized).toBe('acme-supply.co.uk')
    expect(capture.of(DOMAIN_CLAIMED_EVENT)).toHaveLength(1)

    // ── 3. The progress state ────────────────────────────────────────────────
    // What the dashboard reads to stop rendering "Connect your domain" and
    // start rendering the ingestion stepper.
    const afterClaim = await (await account()(get('/api/account'), undefined)).json()
    expect(afterClaim.domain).toEqual({
      normalized: 'acme-supply.co.uk',
      state: 'ingesting',
      platform: null,
    })
    // Still no subscription row, and the claim went through anyway: nothing in
    // the funnel asks anybody to pay.
    expect(afterClaim.subscription.status).toBe('none')

    // And what the stepper's steps come from: a durable run whose first step is
    // waiting for a worker, with every later step pending behind it — the
    // seven-step stepper, gated by the step dependencies.
    const steps = await harness.pool.query<{ step: string; state: string }>(
      'SELECT step, state FROM job_steps WHERE job_id = $1',
      [claimed.ingestionJobId],
    )
    expect(steps.rows.every((row) => row.state === 'pending')).toBe(true)
    expect(steps.rows.map((row) => row.step)).toContain('detect')

    const dispatchable = await dispatchableSteps(harness.db, claimed.ingestionJobId)
    expect(dispatchable.map((step) => step.step)).toEqual(['detect'])
  })

  function get(path: string): Request {
    return new Request(`${APP_URL}${path}`)
  }

})
