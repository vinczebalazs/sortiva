import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  accountScope,
  findGscConnForAccount,
  gscDaily,
  gscQueryDaily,
  saveGscGrant,
  selectGscProperty,
} from '@sortiva/db'
import { jobSteps } from '@sortiva/db'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { silentLogger, type GscSearchAnalyticsRow, type GscTokens } from '@sortiva/core'
import { InMemoryGscProvider } from '@sortiva/providers'
import { createRun, findStep, guardedTransition } from '../runtime/steps'
import { encodeTokens, syncSearchConsoleRange, type TokenCodec } from './sync'
import { runGscBackfillChunk } from './backfill'

const available = await databaseAvailable()

/**
 * Encryption is proved in `packages/providers`; what these tests need is a
 * codec whose output they can inspect, so the shape stored in `gsc_conns.tokens`
 * is visible when something goes wrong.
 */
const plainCodec: TokenCodec = {
  encrypt: (value) => `plain:${value}`,
  decrypt: (value) => {
    if (!value.startsWith('plain:')) throw new Error('not written by this codec')
    return value.slice('plain:'.length)
  },
}

function tokens(over: Partial<GscTokens> = {}): GscTokens {
  return {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    ...over,
  }
}

function row(date: string, over: Partial<GscSearchAnalyticsRow> = {}): GscSearchAnalyticsRow {
  return {
    date,
    page: 'https://example.com/a',
    query: 'trail shoes',
    device: 'DESKTOP',
    country: 'usa',
    clicks: 1,
    impressions: 10,
    position: 6,
    ...over,
  }
}

describe.skipIf(!available)('syncing a store’s search data', () => {
  let ctx: TestDb
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('gsc_sync')
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, `gsc-${Math.random().toString(36).slice(2)}@example.com`)
  })

  async function connect(over: Partial<GscTokens> = {}): Promise<void> {
    const scope = accountScope(accountId)
    await saveGscGrant(ctx.db, scope, { tokens: encodeTokens(plainCodec, tokens(over)) })
    await selectGscProperty(ctx.db, scope, {
      property: 'sc-domain:example.com',
      connectedAt: new Date('2026-09-01T00:00:00Z'),
    })
  }

  it('writes both tables from one report', async () => {
    await connect()
    const provider = new InMemoryGscProvider({
      rows: [
        row('2026-08-30', { clicks: 1, impressions: 10, position: 4 }),
        row('2026-08-30', { query: 'trail running shoes', clicks: 5, impressions: 30, position: 8 }),
      ],
    })

    const outcome = await syncSearchConsoleRange(
      { db: ctx.db, provider, codec: plainCodec, logger: silentLogger },
      accountId,
      { startDate: '2026-08-30', endDate: '2026-08-30' },
    )

    expect(outcome).toMatchObject({ status: 'synced', rowsWritten: 2 })

    const queries = await ctx.db
      .select()
      .from(gscQueryDaily)
      .where(eq(gscQueryDaily.accountId, accountId))
    expect(queries).toHaveLength(2)

    const pages = await ctx.db.select().from(gscDaily).where(eq(gscDaily.accountId, accountId))
    expect(pages).toHaveLength(1)
    expect(pages[0]!.clicks).toBe(6)
    expect(pages[0]!.impressions).toBe(40)
    // (4×10 + 8×30) / 40 — weighted by impressions, not averaged flat.
    expect(Number(pages[0]!.position)).toBeCloseTo(7)
  })

  it('re-running the same window overwrites rather than doubles', async () => {
    await connect()
    const provider = new InMemoryGscProvider({ rows: [row('2026-08-30', { clicks: 3 })] })
    const deps = { db: ctx.db, provider, codec: plainCodec, logger: silentLogger }
    const range = { startDate: '2026-08-30', endDate: '2026-08-30' }

    await syncSearchConsoleRange(deps, accountId, range)
    await syncSearchConsoleRange(deps, accountId, range)

    const queries = await ctx.db
      .select()
      .from(gscQueryDaily)
      .where(eq(gscQueryDaily.accountId, accountId))
    expect(queries).toHaveLength(1)
    expect(queries[0]!.clicks).toBe(3)
  })

  it('pages through a long window until Google stops offering more', async () => {
    await connect()
    const provider = new InMemoryGscProvider({
      rows: Array.from({ length: 7 }, (_, i) =>
        row('2026-08-30', { query: `query-${i}`, clicks: i, impressions: 10 }),
      ),
      pageSize: 3,
    })

    const outcome = await syncSearchConsoleRange(
      { db: ctx.db, provider, codec: plainCodec, logger: silentLogger },
      accountId,
      { startDate: '2026-08-30', endDate: '2026-08-30' },
    )

    expect(outcome).toMatchObject({ status: 'synced', rowsWritten: 7, pages: 3 })
  })

  it('does nothing at all before a property has been chosen', async () => {
    await saveGscGrant(ctx.db, accountScope(accountId), {
      tokens: encodeTokens(plainCodec, tokens()),
    })
    const provider = new InMemoryGscProvider({ rows: [row('2026-08-30')] })

    const outcome = await syncSearchConsoleRange(
      { db: ctx.db, provider, codec: plainCodec, logger: silentLogger },
      accountId,
      { startDate: '2026-08-30', endDate: '2026-08-30' },
    )

    expect(outcome).toEqual({ status: 'not_connected' })
    expect(provider.analyticsRequests).toHaveLength(0)
  })
})

describe.skipIf(!available)('when the merchant’s Google grant dies', () => {
  let ctx: TestDb
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('gsc_grant')
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, `gsc-${Math.random().toString(36).slice(2)}@example.com`)
  })

  async function connectWithExpiredToken(refreshToken: string | null): Promise<void> {
    const scope = accountScope(accountId)
    await saveGscGrant(ctx.db, scope, {
      tokens: encodeTokens(
        plainCodec,
        tokens({ expiresAt: new Date('2020-01-01T00:00:00Z'), refreshToken }),
      ),
    })
    await selectGscProperty(ctx.db, scope, {
      property: 'sc-domain:example.com',
      connectedAt: new Date('2026-09-01T00:00:00Z'),
    })
  }

  it('records the connection as needing re-making, and leaves the pipeline alone', async () => {
    await connectWithExpiredToken('revoked')
    const provider = new InMemoryGscProvider({ rows: [row('2026-08-30')] })

    // The store's content pipeline, represented by the steps a run is made of.
    // Nothing about a dead reporting grant may touch these.
    const { jobId } = await createRun(ctx.db, accountId, 'run-1')
    const before = await ctx.db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId))

    const outcome = await syncSearchConsoleRange(
      { db: ctx.db, provider, codec: plainCodec, logger: silentLogger },
      accountId,
      { startDate: '2026-08-30', endDate: '2026-08-30' },
    )

    expect(outcome).toEqual({ status: 'grant_invalid' })

    const conn = await findGscConnForAccount(ctx.db, accountScope(accountId))
    expect(conn?.invalidatedAt).toBeInstanceOf(Date)

    const after = await ctx.db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId))
    expect(after.map((s) => [s.step, s.state])).toEqual(before.map((s) => [s.step, s.state]))
    // And the steps generation depends on are still dispatchable, not paused.
    expect(after.find((s) => s.step === 'catalog_sync')?.state).toBe('pending')
  })

  it('treats a grant with nothing to renew as needing re-making, not as an error', async () => {
    await connectWithExpiredToken(null)
    const provider = new InMemoryGscProvider({ rows: [row('2026-08-30')] })

    const outcome = await syncSearchConsoleRange(
      { db: ctx.db, provider, codec: plainCodec, logger: silentLogger },
      accountId,
      { startDate: '2026-08-30', endDate: '2026-08-30' },
    )

    expect(outcome).toEqual({ status: 'grant_invalid' })
    expect(provider.refreshCalls).toBe(0)
  })

  it('keeps the moment of the first discovery, so the reconnect prompt lands once', async () => {
    await connectWithExpiredToken('revoked')
    const provider = new InMemoryGscProvider({})
    const deps = { db: ctx.db, provider, codec: plainCodec, logger: silentLogger }
    const range = { startDate: '2026-08-30', endDate: '2026-08-30' }

    await syncSearchConsoleRange(deps, accountId, range)
    const first = (await findGscConnForAccount(ctx.db, accountScope(accountId)))!.invalidatedAt
    await syncSearchConsoleRange(deps, accountId, range)
    const second = (await findGscConnForAccount(ctx.db, accountScope(accountId)))!.invalidatedAt

    expect(second).toEqual(first)
  })

  it('renews a nearly-expired token and keeps the renewal, rather than renewing every run', async () => {
    const scope = accountScope(accountId)
    await saveGscGrant(ctx.db, scope, {
      tokens: encodeTokens(plainCodec, tokens({ expiresAt: new Date('2020-01-01T00:00:00Z') })),
    })
    await selectGscProperty(ctx.db, scope, {
      property: 'sc-domain:example.com',
      connectedAt: new Date('2026-09-01T00:00:00Z'),
    })

    const provider = new InMemoryGscProvider({ rows: [row('2026-08-30')] })
    const deps = { db: ctx.db, provider, codec: plainCodec, logger: silentLogger }
    const range = { startDate: '2026-08-30', endDate: '2026-08-30' }

    await syncSearchConsoleRange(deps, accountId, range)
    await syncSearchConsoleRange(deps, accountId, range)

    expect(provider.refreshCalls).toBe(1)
  })

  it('keeps the old renewal key when Google declines to issue a new one', async () => {
    const scope = accountScope(accountId)
    await saveGscGrant(ctx.db, scope, {
      tokens: encodeTokens(plainCodec, tokens({ expiresAt: new Date('2020-01-01T00:00:00Z') })),
    })
    await selectGscProperty(ctx.db, scope, {
      property: 'sc-domain:example.com',
      connectedAt: new Date('2026-09-01T00:00:00Z'),
    })

    const provider = new InMemoryGscProvider({ rows: [], withholdRefreshToken: true })
    await syncSearchConsoleRange(
      { db: ctx.db, provider, codec: plainCodec, logger: silentLogger },
      accountId,
      { startDate: '2026-08-30', endDate: '2026-08-30' },
    )

    const conn = await findGscConnForAccount(ctx.db, scope)
    const stored = JSON.parse(plainCodec.decrypt(conn!.tokens)) as { refreshToken: string | null }
    expect(stored.refreshToken).toBe('refresh')
  })
})

describe.skipIf(!available)('importing sixteen months of history', () => {
  let ctx: TestDb
  let accountId: string

  const config = { backfill_months: 2, backfill_chunk_days: 30, data_lag_days: 2 }
  const now = () => new Date('2026-09-02T09:00:00Z')

  beforeAll(async () => {
    ctx = await setupTestDb('gsc_backfill')
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, `gsc-${Math.random().toString(36).slice(2)}@example.com`)
    const scope = accountScope(accountId)
    await saveGscGrant(ctx.db, scope, { tokens: encodeTokens(plainCodec, tokens()) })
    await selectGscProperty(ctx.db, scope, {
      property: 'sc-domain:example.com',
      connectedAt: new Date('2026-09-01T00:00:00Z'),
    })
  })

  function deps(provider: InMemoryGscProvider) {
    return { db: ctx.db, provider, codec: plainCodec, logger: silentLogger, now, config }
  }

  it('does one date range at a time, and hands the rest on', async () => {
    const provider = new InMemoryGscProvider({ rows: [row('2026-08-15'), row('2026-07-15')] })

    const first = await runGscBackfillChunk(deps(provider), { accountId })
    expect(first.status).toBe('chunk_done')
    if (first.status !== 'chunk_done') throw new Error('unreachable')

    // Newest first: the most recent chunk ends on the last day Google has
    // finished counting.
    expect(first.range.endDate).toBe('2026-08-31')
    expect(provider.analyticsRequests).toHaveLength(1)
    expect(provider.analyticsRequests[0]).toMatchObject({
      startDate: first.range.startDate,
      endDate: first.range.endDate,
    })
    expect(first.next.completed).toEqual([`${first.range.startDate}..${first.range.endDate}`])
  })

  it('resumes where it left off, and never re-fetches a range already written', async () => {
    const provider = new InMemoryGscProvider({ rows: [row('2026-08-15'), row('2026-07-15')] })
    const d = deps(provider)

    let payload = { accountId } as Parameters<typeof runGscBackfillChunk>[1]
    const done: string[] = []
    for (let i = 0; i < 10; i += 1) {
      const step = await runGscBackfillChunk(d, payload)
      if (step.status === 'finished') break
      if (step.status !== 'chunk_done') throw new Error(`unexpected ${step.status}`)
      done.push(`${step.range.startDate}..${step.range.endDate}`)
      payload = step.next
    }

    // Every range asked for exactly once, and never the same one twice.
    expect(new Set(done).size).toBe(done.length)
    expect(provider.analyticsRequests).toHaveLength(done.length)

    // Resuming from the finished checkpoint asks Google for nothing more.
    const requestsBefore = provider.analyticsRequests.length
    const again = await runGscBackfillChunk(d, payload)
    expect(again.status).toBe('finished')
    expect(provider.analyticsRequests).toHaveLength(requestsBefore)
  })

  it('a crash between writing a chunk and recording it costs that chunk, not the import', async () => {
    const provider = new InMemoryGscProvider({ rows: [row('2026-08-15')] })
    const d = deps(provider)

    const first = await runGscBackfillChunk(d, { accountId })
    if (first.status !== 'chunk_done') throw new Error('unreachable')

    // The worker died before the next job was queued, so the same payload is
    // delivered again. The chunk is fetched a second time and its rows land on
    // top of themselves rather than beside them.
    const redelivered = await runGscBackfillChunk(d, { accountId })
    if (redelivered.status !== 'chunk_done') throw new Error('unreachable')
    expect(redelivered.range).toEqual(first.range)

    const queries = await ctx.db
      .select()
      .from(gscQueryDaily)
      .where(eq(gscQueryDaily.accountId, accountId))
    expect(queries).toHaveLength(1)
  })

  it('stops the import when the grant dies part-way, without failing the job', async () => {
    const provider = new InMemoryGscProvider({
      rows: [row('2026-08-15'), row('2026-07-15')],
      revokedAfterCalls: 1,
    })
    const d = deps(provider)

    const first = await runGscBackfillChunk(d, { accountId })
    if (first.status !== 'chunk_done') throw new Error('unreachable')

    const second = await runGscBackfillChunk(d, first.next)
    expect(second).toEqual({ status: 'stopped', reason: 'grant_invalid' })

    const conn = await findGscConnForAccount(ctx.db, accountScope(accountId))
    expect(conn?.invalidatedAt).toBeInstanceOf(Date)
  })
})

describe.skipIf(!available)('the onboarding step the merchant can skip', () => {
  let ctx: TestDb

  beforeAll(async () => {
    ctx = await setupTestDb('gsc_step')
  })

  afterAll(async () => {
    await ctx?.close()
  })

  it('skipping Search Console never blocks the rest of onboarding', async () => {
    await truncateAll(ctx.pool)
    const accountId = await insertAccount(ctx.pool, `gsc-step-${Math.random().toString(36).slice(2)}@example.com`)
    const { jobId } = await createRun(ctx.db, accountId, 'run-1')

    const step = await findStep(ctx.db, jobId, 'gsc_connect')
    const moved = await guardedTransition(ctx.db, step!.id, 'pending', 'skipped')
    expect(moved?.state).toBe('skipped')

    const confirmation = await findStep(ctx.db, jobId, 'awaiting_confirmation')
    expect(confirmation!.state).toBe('pending')
  })
})
