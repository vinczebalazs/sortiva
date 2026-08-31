import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PostgresRequestCache } from './cache'
import { databaseAvailable, setupTestDb, truncateAll, type TestDb } from './testing'

/**
 * main §14.3.6 / invariant 20 against a real Postgres. A cache asserted in
 * TypeScript is not a cache: the whole guarantee is that the row is committed
 * before processing, and only the database can prove that.
 */

let harness: TestDb
let cache: PostgresRequestCache

beforeAll(async () => {
  if (!(await databaseAvailable())) {
    // Fail loudly rather than skip: a silently-skipped suite reports green
    // while proving nothing (T0.3 convention).
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before the test suite.')
  }
  harness = await setupTestDb('request_cache')
  cache = new PostgresRequestCache(harness.db)
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
})

const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000)

describe('PostgresRequestCache', () => {
  it('round-trips a stored response', async () => {
    await cache.writeBeforeProcessing({
      cacheKey: 'llm:distill.v1:m:abc',
      kind: 'llm',
      responseJson: { text: '{"summary":"x"}' },
      expiresAt: inAnHour(),
    })

    const entry = await cache.read('llm:distill.v1:m:abc')
    expect(entry?.responseJson).toEqual({ text: '{"summary":"x"}' })
    expect(entry?.kind).toBe('llm')
  })

  it('does not serve an expired entry', async () => {
    await cache.writeBeforeProcessing({
      cacheKey: 'dataforseo:serp:abc',
      kind: 'dataforseo',
      responseJson: { result: [] },
      expiresAt: new Date(Date.now() - 1000),
    })

    expect(await cache.read('dataforseo:serp:abc')).toBeUndefined()
  })

  it('lets a re-run overwrite its own key instead of conflicting', async () => {
    const write = (text: string) =>
      cache.writeBeforeProcessing({
        cacheKey: 'llm:persona.v1:m:same',
        kind: 'llm',
        responseJson: { text },
        expiresAt: inAnHour(),
      })

    await write('first')
    await expect(write('second')).resolves.toBeUndefined()
    expect(await cache.read('llm:persona.v1:m:same')).toMatchObject({
      responseJson: { text: 'second' },
    })
  })

  it('returns nothing for a key never written', async () => {
    expect(await cache.read('llm:never:written')).toBeUndefined()
  })
})
