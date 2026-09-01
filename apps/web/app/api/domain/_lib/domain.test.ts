import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DOMAIN_ALREADY_CLAIMED_MESSAGE, DOMAIN_CLAIMED_EVENT, ingestionRunId } from '@sortiva/core'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { dispatchableSteps } from '@sortiva/jobs/runtime/steps'
import { MockPosthogCapture } from '@sortiva/providers'
import { withAccount } from '../../auth/_lib/session'
import { makeClaimHandler } from './handler'
import { makeDomainClaimStore } from './store'

/**
 * main §5 and invariant 1 against a real database, because the whole point of
 * the claim is a race two transactions have with each other, and a race can
 * only be lost in SQL.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('POST /api/domain/claim (main §5, ui §3.1)', () => {
  let harness: TestDb
  let capture: MockPosthogCapture

  beforeAll(async () => {
    harness = await setupTestDb('web_domain_claim')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    capture = new MockPosthogCapture()
  })

  function claimAs(accountId: string) {
    return withAccount(
      makeClaimHandler({
        deps: { store: makeDomainClaimStore({ database: harness.db }), capture },
      }),
      async () => accountId,
    )
  }

  function post(domain: unknown): Request {
    return new Request('https://app.sortiva.test/api/domain/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain }),
    })
  }

  async function claim(accountId: string, domain: unknown): Promise<Response> {
    return claimAs(accountId)(post(domain), undefined)
  }

  async function rowCount(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await harness.pool.query<{ n: string }>(sql, params)
    return Number(rows[0]!.n)
  }

  it('claims at eTLD+1, flips the domain into ingesting, and enqueues the run', async () => {
    const accountId = await insertAccount(harness.pool, 'merchant@example.com')

    const response = await claim(accountId, 'https://www.Shop.Example.co.uk/collections/all')
    expect(response.status).toBe(200)
    const body = await response.json()

    // main §2 — the claim is at the registrable domain, not the host typed.
    expect(body.normalized).toBe('example.co.uk')
    // main §5 step 3 / ui §3.2 — the dashboard flips to the progress stepper.
    expect(body.state).toBe('ingesting')
    expect(body.ingestionJobId).toMatch(/^[0-9a-f-]{36}$/)

    const stored = await harness.pool.query(
      'SELECT domain_normalized, state, release_after FROM domains WHERE account_id = $1',
      [accountId],
    )
    expect(stored.rows).toEqual([
      { domain_normalized: 'example.co.uk', state: 'ingesting', release_after: null },
    ])

    // main §5 step 3 — "Claiming enqueues the deep ingestion job".
    const run = await harness.pool.query<{ id: string; run_id: string; status: string }>(
      'SELECT id, run_id, status FROM ingestion_jobs WHERE account_id = $1',
      [accountId],
    )
    expect(run.rows).toHaveLength(1)
    expect(run.rows[0]!.id).toBe(body.ingestionJobId)
    // §14.3.2 — derived from the claim, never random.
    expect(run.rows[0]!.run_id).toBe(ingestionRunId('example.co.uk'))

    const steps = await harness.pool.query<{ step: string; state: string }>(
      'SELECT step, state FROM job_steps WHERE job_id = $1 ORDER BY step',
      [body.ingestionJobId],
    )
    expect(steps.rows).toContainEqual({ step: 'detect', state: 'pending' })

    // The done-when's "`detect` step pending" as the worker runtime sees it:
    // `detect` is the only step whose dependencies are met, so a worker picking
    // this run up starts platform detection and nothing else (main §14.3.1).
    const dispatchable = await dispatchableSteps(harness.db, body.ingestionJobId)
    expect(dispatchable.map((s) => s.step)).toEqual(['detect'])

    // main §14.7 — the funnel event, carrying the domain group from this moment.
    const claimed = capture.of(DOMAIN_CLAIMED_EVENT)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.distinctId).toBe(accountId)
    expect(claimed[0]!.groups).toEqual({ domain: 'example.co.uk' })
  })

  it("refuses another account's domain with main §5's exact words", async () => {
    const owner = await insertAccount(harness.pool, 'owner@example.com')
    const squatter = await insertAccount(harness.pool, 'squatter@example.com')

    expect((await claim(owner, 'example.com')).status).toBe(200)

    const response = await claim(squatter, 'https://blog.example.com/hello')
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: {
        code: 'domain_already_claimed',
        message: DOMAIN_ALREADY_CLAIMED_MESSAGE,
      },
    })

    // The refused claim left nothing behind: no row, no ingestion run.
    expect(await rowCount('SELECT count(*) n FROM domains WHERE account_id = $1', [squatter])).toBe(0)
    expect(
      await rowCount('SELECT count(*) n FROM ingestion_jobs WHERE account_id = $1', [squatter]),
    ).toBe(0)
    // Only the real claim is a funnel event.
    expect(capture.of(DOMAIN_CLAIMED_EVENT)).toHaveLength(1)
  })

  it('is a silent no-op when the same merchant claims the same domain again', async () => {
    const accountId = await insertAccount(harness.pool, 'merchant@example.com')

    const first = await claim(accountId, 'example.com')
    const firstBody = await first.json()

    // A different spelling of the same business, as a returning user would type.
    const second = await claim(accountId, 'https://WWW.shop.example.com/pages/about')
    expect(second.status).toBe(200)
    const secondBody = await second.json()

    // main §5 — "no-op / redirect to dashboard": same domain, same run, so the
    // client lands on the same progress screen instead of a second onboarding.
    expect(secondBody).toEqual(firstBody)
    expect(await rowCount('SELECT count(*) n FROM domains WHERE account_id = $1', [accountId])).toBe(1)
    expect(
      await rowCount('SELECT count(*) n FROM ingestion_jobs WHERE account_id = $1', [accountId]),
    ).toBe(1)
    expect(capture.of(DOMAIN_CLAIMED_EVENT)).toHaveLength(1)
  })

  it('refuses a second, different domain for one account (invariant 1)', async () => {
    const accountId = await insertAccount(harness.pool, 'merchant@example.com')
    expect((await claim(accountId, 'first.com')).status).toBe(200)

    const response = await claim(accountId, 'second.com')
    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body.error.code).toBe('account_has_other_domain')
    // The merchant is told which domain they already hold, not that someone
    // else took the one they typed.
    expect(body.error.message).toContain('first.com')
    expect(body.error.message).not.toBe(DOMAIN_ALREADY_CLAIMED_MESSAGE)

    expect(await rowCount('SELECT count(*) n FROM domains WHERE account_id = $1', [accountId])).toBe(1)
  })

  it('rejects an address that is not a domain (ui §3.1)', async () => {
    const accountId = await insertAccount(harness.pool, 'merchant@example.com')

    for (const bad of ['not a website', '127.0.0.1', 'example.con', 'ftp://example.com']) {
      const response = await claim(accountId, bad)
      expect(response.status, bad).toBe(422)
      expect((await response.json()).error.code, bad).toBe('invalid_domain')
    }
    expect(await rowCount('SELECT count(*) n FROM domains', [])).toBe(0)
  })

  it('lets exactly one of eight simultaneous claims win', async () => {
    const accounts = await Promise.all(
      Array.from({ length: 8 }, (_, i) => insertAccount(harness.pool, `race${i}@example.com`)),
    )

    // Eight different spellings of one business, sent at once: the normaliser
    // folds them to one key and the unique index picks one winner.
    const spellings = [
      'example.com',
      'www.example.com',
      'https://example.com/',
      'http://shop.example.com',
      'EXAMPLE.COM',
      'https://www.example.com/collections/all?x=1',
      'blog.example.com:8443',
      'example.com.',
    ]
    const responses = await Promise.all(accounts.map((id, i) => claim(id, spellings[i]!)))
    const statuses = responses.map((r) => r.status).sort()

    expect(statuses.filter((s) => s === 200)).toHaveLength(1)
    expect(statuses.filter((s) => s === 409)).toHaveLength(7)

    // The database is the referee, so check the database and not the answers.
    expect(await rowCount("SELECT count(*) n FROM domains WHERE domain_normalized = 'example.com'"))
      .toBe(1)
    expect(await rowCount('SELECT count(*) n FROM ingestion_jobs')).toBe(1)
    expect(capture.of(DOMAIN_CLAIMED_EVENT)).toHaveLength(1)
  })

  it('would let both claims through if the unique index were gone', async () => {
    // The teeth of the test above. Without this, "exactly one won" could be an
    // accident of two requests never overlapping. Dropping the index is the
    // mutation: invariant 1 is enforced by that index and by nothing else in
    // application code, so removing it must break the guarantee — and does.
    const a = await insertAccount(harness.pool, 'a@example.com')
    const b = await insertAccount(harness.pool, 'b@example.com')

    await harness.pool.query('DROP INDEX domains_domain_normalized_key')
    try {
      const responses = await Promise.all([claim(a, 'example.com'), claim(b, 'example.com')])
      expect(responses.map((r) => r.status)).toEqual([200, 200])
      expect(
        await rowCount("SELECT count(*) n FROM domains WHERE domain_normalized = 'example.com'"),
      ).toBe(2)
    } finally {
      await harness.pool.query('DELETE FROM domains')
      await harness.pool.query('DELETE FROM ingestion_jobs')
      await harness.pool.query(
        'CREATE UNIQUE INDEX domains_domain_normalized_key ON domains (domain_normalized)',
      )
    }

    // Restored: the same two claims now behave again.
    const responses = await Promise.all([claim(a, 'example.com'), claim(b, 'example.com')])
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
  })

  it('keeps a domain blocked while a deleted account is inside its grace window', async () => {
    // main §14.6 — "domain claim released after a 7-day grace window (protects
    // against accidental deletion freeing the domain to a squatter the same
    // hour)". `domains.release_after` is the deadline the deletion sweep (T8.3)
    // reads before hard-deleting the row; it is *not* a modifier on the unique
    // index. So the claim path ignores it entirely: the row is what blocks, and
    // it blocks until it is gone. Pinned here because a timestamp column that
    // looks like it weakens uniqueness and does not is worth stating out loud.
    // See DECISIONS 2026-09-01 T1.4.
    const leaver = await insertAccount(harness.pool, 'leaving@example.com')
    const squatter = await insertAccount(harness.pool, 'squatter@example.com')
    expect((await claim(leaver, 'example.com')).status).toBe(200)

    for (const releaseAfter of ["now() + interval '3 days'", "now() - interval '1 day'"]) {
      await harness.pool.query(
        `UPDATE domains SET release_after = ${releaseAfter} WHERE account_id = $1`,
        [leaver],
      )
      expect((await claim(squatter, 'example.com')).status).toBe(409)
    }

    // Released means gone: once the sweep deletes the row, the domain is free.
    await harness.pool.query('DELETE FROM domains WHERE account_id = $1', [leaver])
    expect((await claim(squatter, 'example.com')).status).toBe(200)
  })

  it('answers 401 without a session (tech §3)', async () => {
    const handler = withAccount(
      makeClaimHandler({
        deps: { store: makeDomainClaimStore({ database: harness.db }), capture },
      }),
      async () => null,
    )
    const response = await handler(post('example.com'), undefined)
    expect(response.status).toBe(401)
    expect(await rowCount('SELECT count(*) n FROM domains')).toBe(0)
  })
})
