import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { diagnoseStore, diagnosisScope } from './diagnose'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from './testing'

/**
 * T-OPS: the diagnosis read has to find a store by either of the two things
 * support ever has — the address the merchant signed up with, or the website
 * they connected — and it has to say nothing rather than something when there
 * is no such store.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('diagnoseStore', () => {
  let test: TestDb
  let accountId: string

  beforeAll(async () => {
    test = await setupTestDb('tops_diagnose')
  })

  afterAll(async () => {
    await test.close()
  })

  beforeEach(async () => {
    await truncateAll(test.pool)
    accountId = await insertAccount(test.pool, 'stuck@example-outdoor.com')
    await test.pool.query(
      `INSERT INTO domains (account_id, domain_normalized, platform, state) VALUES ($1, 'example-outdoor.com', 'shopify', 'ingesting')`,
      [accountId],
    )
    await test.pool.query(
      `INSERT INTO shopify_conns (account_id, shop_handle, access_token, granted_scopes)
       VALUES ($1, 'example-outdoor', 'ciphertext', ARRAY['read_products','read_orders'])`,
      [accountId],
    )
    const { rows } = await test.pool.query<{ id: string }>(
      `INSERT INTO ingestion_jobs (account_id, run_id) VALUES ($1, 'claim:example-outdoor.com') RETURNING id`,
      [accountId],
    )
    const jobId = rows[0]!.id
    await test.pool.query(
      `INSERT INTO job_steps (job_id, step, state, idempotency_key, attempts, last_error, checkpoint)
       VALUES ($1, 'detect', 'succeeded', 'k-detect', 1, NULL, NULL),
              ($1, 'oauth_wait', 'succeeded', 'k-oauth', 1, NULL, NULL),
              ($1, 'catalog_sync', 'failed_terminal', 'k-catalog', 4, 'Shopify returned 500 four times', '{"cursor":"page-7"}'),
              ($1, 'distill', 'pending', 'unassigned', 0, NULL, NULL)`,
      [jobId],
    )
    await test.pool.query(
      `INSERT INTO job_dlq (account_id, job_id, step, idempotency_key, error_class, last_error, attempts, first_failed_at)
       VALUES ($1, $2, 'catalog_sync', 'k-catalog', 'upstream_5xx', 'Shopify returned 500 four times', 4, now())`,
      [accountId, jobId],
    )
  })

  it('finds the store by the address it signed up with', async () => {
    const diagnosis = await diagnoseStore(test.db, diagnosisScope(), {
      email: 'stuck@example-outdoor.com',
    })
    expect(diagnosis?.accountId).toBe(accountId)
    expect(diagnosis?.domain?.normalized).toBe('example-outdoor.com')
  })

  it('finds the same store by the website it connected, however the operator pastes it', async () => {
    for (const typed of [
      'example-outdoor.com',
      'www.example-outdoor.com',
      'https://EXAMPLE-outdoor.com/collections/boots',
    ]) {
      const diagnosis = await diagnoseStore(test.db, diagnosisScope(), { domain: typed })
      expect(diagnosis?.accountId, typed).toBe(accountId)
    }
  })

  it('prints every pipeline step, with the failing one carrying its reason', async () => {
    const diagnosis = await diagnoseStore(test.db, diagnosisScope(), { domain: 'example-outdoor.com' })
    expect(diagnosis!.runs).toHaveLength(1)

    const steps = diagnosis!.runs[0]!.steps
    expect(steps.map((s) => s.step).sort()).toEqual([
      'catalog_sync',
      'detect',
      'distill',
      'oauth_wait',
    ])

    const failing = steps.find((s) => s.step === 'catalog_sync')!
    expect(failing.state).toBe('failed_terminal')
    expect(failing.attempts).toBe(4)
    expect(failing.lastError).toBe('Shopify returned 500 four times')
    expect(failing.hasCheckpoint).toBe(true)
  })

  it('shows the connection state and the work waiting to be replayed', async () => {
    const diagnosis = await diagnoseStore(test.db, diagnosisScope(), { email: 'stuck@example-outdoor.com' })
    expect(diagnosis!.shopify).toMatchObject({
      shopHandle: 'example-outdoor',
      grantedScopes: ['read_products', 'read_orders'],
    })
    expect(diagnosis!.searchConsole).toBeNull()
    expect(diagnosis!.openDeadLetters).toHaveLength(1)
    expect(diagnosis!.openDeadLetters[0]).toMatchObject({
      step: 'catalog_sync',
      errorClass: 'upstream_5xx',
    })
  })

  it('answers null — not an empty report — when there is no such store', async () => {
    await expect(
      diagnoseStore(test.db, diagnosisScope(), { email: 'nobody@example.com' }),
    ).resolves.toBeNull()
    await expect(
      diagnoseStore(test.db, diagnosisScope(), { domain: 'not-a-customer.com' }),
    ).resolves.toBeNull()
  })

  it('says nothing rather than something when a store exists but has never started', async () => {
    const other = await insertAccount(test.pool, 'fresh@example.com')
    const diagnosis = await diagnoseStore(test.db, diagnosisScope(), { email: 'fresh@example.com' })
    expect(diagnosis?.accountId).toBe(other)
    expect(diagnosis?.domain).toBeNull()
    expect(diagnosis?.runs).toEqual([])
    expect(diagnosis?.openDeadLetters).toEqual([])
  })
})
