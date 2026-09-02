import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createLogger, serpSnapshotKey } from '@sortiva/core'
import {
  accountScope,
  makeKeywordStore,
  systemScope,
  upsertPersona,
  upsertSerpSnapshot,
} from '@sortiva/db'
import {
  TEST_DATABASE_URL,
  databaseAvailable,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { TRUNCATE_QUEUE_SQL, installQueueSchema, type WorkerUtils } from '@sortiva/jobs/runtime/testing'
import { withAccount } from '../../auth/_lib/session'
import {
  competitorSuggestions,
  makeAddCompetitorHandler,
  makeAddKeywordHandler,
  makeRemoveCompetitorHandler,
  type ProfileDeps,
} from './handlers'

/**
 * The two lists a merchant edits, driven end to end: the real session wrapper,
 * the real handlers, the real repositories, a real Postgres and a real queue.
 *
 * The cases that matter are the refusals. A sixth competitor, their own store,
 * and a marketplace each have to be refused **here** and not only by the
 * database — and each has to be refused in the shape the screen already reads,
 * or the merchant is shown the wrong message about which rule they hit.
 *
 * The other property asserted here is that adding a keyword costs a queue row
 * and no vendor call. A request that spends money is a request a double-click
 * can spend twice.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('the store profile’s keyword and competitor lists', () => {
  let harness: TestDb
  let queue: WorkerUtils
  let mine: string
  let theirs: string
  let deps: ProfileDeps

  const session = (accountId: string) => async () => accountId

  beforeAll(async () => {
    harness = await setupTestDb('web_profile')
    const url = new URL(TEST_DATABASE_URL)
    url.pathname = `/${harness.databaseName}`
    queue = await installQueueSchema(url.toString())
  }, 60_000)

  afterAll(async () => {
    await queue?.release()
    await harness?.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    await harness.pool.query(TRUNCATE_QUEUE_SQL)
    const { rows } = await harness.pool.query<{ id: string; email: string }>(
      "INSERT INTO accounts (email) VALUES ('mine@example.com'), ('theirs@example.com') RETURNING id, email",
    )
    mine = rows.find((row) => row.email === 'mine@example.com')!.id
    theirs = rows.find((row) => row.email === 'theirs@example.com')!.id

    for (const [accountId, domain] of [
      [mine, 'acme-store.com'],
      [theirs, 'other-store.com'],
    ] as const) {
      await harness.pool.query(
        `insert into domains (account_id, domain_normalized, platform, state)
         values ($1, $2, 'shopify', 'needs_confirmation')`,
        [accountId, domain],
      )
      await upsertPersona(harness.db, accountScope(accountId), {
        description: 'A shop.',
        productCategories: ['shoes'],
        language: 'en',
        country: 'GB',
        audience: 'runners',
        tone: 'plain',
        richnessScore: 5,
        promptVersion: 'persona.v1',
        modelId: 'claude-sonnet-test',
      })
    }

    deps = {
      store: makeKeywordStore({ database: harness.db }),
      log: createLogger({ base: { component: 'profile-test' } }),
    }
  })

  function post(body: unknown): Request {
    return new Request('http://localhost/api/profile/competitors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async function addCompetitor(body: unknown, accountId = mine): Promise<Response> {
    return withAccount(makeAddCompetitorHandler(deps), session(accountId))(post(body), {})
  }

  describe('the five-competitor cap, in the API', () => {
    it('accepts five and refuses the sixth with the code the screen reads', async () => {
      for (let i = 1; i <= 5; i += 1) {
        const ok = await addCompetitor({ domain: `rival${i}.com` })
        expect(ok.status).toBe(200)
      }

      const sixth = await addCompetitor({ domain: 'rival6.com' })
      expect(sixth.status).toBe(409)
      expect((await sixth.json()).error.code).toBe('competitor_limit_reached')

      const { rows } = await harness.pool.query<{ n: number }>(
        'select count(*)::int as n from competitors where account_id = $1',
        [mine],
      )
      expect(rows[0]?.n).toBe(5)
    })

    it('frees a slot when one is removed', async () => {
      for (let i = 1; i <= 5; i += 1) await addCompetitor({ domain: `rival${i}.com` })
      const { rows } = await harness.pool.query<{ id: string }>(
        'select id from competitors where account_id = $1 limit 1',
        [mine],
      )

      const removed = await withAccount(
        makeRemoveCompetitorHandler(deps),
        session(mine),
      )(new Request('http://localhost', { method: 'DELETE' }), {
        params: Promise.resolve({ competitorId: rows[0]!.id }),
      })
      expect(removed.status).toBe(200)
      expect((await addCompetitor({ domain: 'rival6.com' })).status).toBe(200)
    })

    it('will not let one merchant remove another’s competitor', async () => {
      await addCompetitor({ domain: 'rival1.com' })
      const { rows } = await harness.pool.query<{ id: string }>(
        'select id from competitors where account_id = $1',
        [mine],
      )

      const refused = await withAccount(
        makeRemoveCompetitorHandler(deps),
        session(theirs),
      )(new Request('http://localhost', { method: 'DELETE' }), {
        params: Promise.resolve({ competitorId: rows[0]!.id }),
      })
      expect(refused.status).toBe(404)
    })
  })

  describe('what a typed competitor has to be', () => {
    it('refuses the merchant’s own store, however they spell it', async () => {
      const refused = await addCompetitor({ domain: 'https://WWW.Acme-Store.com/collections/all' })
      expect(refused.status).toBe(409)
      expect((await refused.json()).error.code).toBe('competitor_is_own_domain')
    })

    it('refuses a marketplace, and takes it when the merchant says so deliberately', async () => {
      const warned = await addCompetitor({ domain: 'amazon.de' })
      // Not a 409: the screen reads any other refusal as the marketplace
      // warning and offers "add anyway" back, which is exactly what should
      // happen here.
      expect(warned.status).toBe(422)
      expect((await warned.json()).error.code).toBe('competitor_on_blocklist')

      const insisted = await addCompetitor({ domain: 'amazon.de', overrideBlocklist: true })
      expect(insisted.status).toBe(200)
      expect((await insisted.json()).domain).toBe('amazon.de')
    })

    it('will not let "add anyway" wave through their own store', async () => {
      const refused = await addCompetitor({ domain: 'acme-store.com', overrideBlocklist: true })
      expect(refused.status).toBe(409)
      expect((await refused.json()).error.code).toBe('competitor_is_own_domain')
    })

    it('normalises whatever was typed, so one rival is one row', async () => {
      expect((await addCompetitor({ domain: 'https://www.rival-shoes.com/shop' })).status).toBe(200)
      expect((await addCompetitor({ domain: 'RIVAL-SHOES.com' })).status).toBe(200)
      const { rows } = await harness.pool.query<{ n: number }>(
        'select count(*)::int as n from competitors where account_id = $1',
        [mine],
      )
      expect(rows[0]?.n).toBe(1)
    })

    it('refuses a domain nobody can find, when somebody looked', async () => {
      const withResolver: ProfileDeps = { ...deps, resolver: { async resolves() { return false } } }
      const refused = await withAccount(
        makeAddCompetitorHandler(withResolver),
        session(mine),
      )(post({ domain: 'nosuchsite.com' }), {})
      expect(refused.status).toBe(400)
      expect((await refused.json()).error.code).toBe('competitor_unresolvable')
    })

    it('proceeds when the lookup itself fails, rather than blocking the merchant', async () => {
      const brokenResolver: ProfileDeps = {
        ...deps,
        resolver: {
          async resolves() {
            throw new Error('the resolver is having a bad second')
          },
        },
      }
      const accepted = await withAccount(
        makeAddCompetitorHandler(brokenResolver),
        session(mine),
      )(post({ domain: 'rival-shoes.com' }), {})
      expect(accepted.status).toBe(200)
    })
  })

  describe('adding a search term', () => {
    it('answers immediately with an unpriced row and asks the queue to price it', async () => {
      const response = await withAccount(
        makeAddKeywordHandler(deps),
        session(mine),
      )(
        new Request('http://localhost/api/profile/keywords', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ term: '  Barefoot   Trail Shoes ' }),
        }),
        {},
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.term).toBe('barefoot trail shoes')
      expect(body.monthlySearchVolume).toBeNull()
      expect(body.enrichmentState).toBe('pending')

      const { rows } = await harness.pool.query<{ task_identifier: string; priority: number }>(
        'select task_identifier, priority from graphile_worker.jobs',
      )
      expect(rows.map((row) => row.task_identifier)).toEqual(['keyword_enrich'])
      expect(rows[0]?.priority).toBeLessThan(0)
    })
  })

  describe('the domains suggested underneath the list', () => {
    it('counts how many of the merchant’s own searches a domain ranks for, and writes nothing', async () => {
      const scope = accountScope(mine)
      const system = systemScope('test writes the snapshots the step would have written')
      const locale = { language: 'en', country: 'GB' }
      const terms = ['trail shoes', 'wide trail shoes', 'best trail shoes']

      for (const term of terms) {
        await harness.pool.query(
          `insert into keywords (account_id, term, language, country, source, confirmed)
           values ($1, $2, 'en', 'GB', 'auto', true)`,
          [mine, term],
        )
        await upsertSerpSnapshot(harness.db, system, {
          cacheKey: serpSnapshotKey({ query: term, locale, depth: 10 }),
          query: term,
          locale: 'en-GB',
          results: [
            { position: 1, url: `https://amazon.de/${term}`, domain: 'amazon.de', title: null },
            { position: 2, url: `https://rival-shoes.com/${term}`, domain: 'rival-shoes.com', title: null },
            { position: 3, url: `https://acme-store.com/${term}`, domain: 'acme-store.com', title: null },
          ],
          fetchedAt: new Date('2026-09-01T00:00:00Z'),
          expiresAt: new Date('2026-09-08T00:00:00Z'),
        })
      }

      const suggestions = await competitorSuggestions(
        deps,
        scope,
        new Date('2026-09-03T00:00:00Z'),
      )

      expect(suggestions).toEqual([{ domain: 'rival-shoes.com', appearsInQueries: 3 }])

      // The whole point: computing a suggestion adds nobody to the list.
      const { rows } = await harness.pool.query<{ n: number }>(
        'select count(*)::int as n from competitors where account_id = $1',
        [mine],
      )
      expect(rows[0]?.n).toBe(0)
    })

    it('stops suggesting a domain once the merchant has added it', async () => {
      const scope = accountScope(mine)
      const system = systemScope('test writes the snapshots the step would have written')
      const locale = { language: 'en', country: 'GB' }

      for (const term of ['trail shoes', 'wide trail shoes', 'best trail shoes']) {
        await harness.pool.query(
          `insert into keywords (account_id, term, language, country, source, confirmed)
           values ($1, $2, 'en', 'GB', 'auto', true)`,
          [mine, term],
        )
        await upsertSerpSnapshot(harness.db, system, {
          cacheKey: serpSnapshotKey({ query: term, locale, depth: 10 }),
          query: term,
          locale: 'en-GB',
          results: [
            { position: 2, url: `https://rival-shoes.com/${term}`, domain: 'rival-shoes.com', title: null },
          ],
          fetchedAt: new Date('2026-09-01T00:00:00Z'),
          expiresAt: new Date('2026-09-08T00:00:00Z'),
        })
      }

      await addCompetitor({ domain: 'rival-shoes.com' })
      expect(
        await competitorSuggestions(deps, scope, new Date('2026-09-03T00:00:00Z')),
      ).toEqual([])
    })

    it('says nothing at all from a results page past its week', async () => {
      const scope = accountScope(mine)
      const system = systemScope('test writes a snapshot that has since expired')
      const locale = { language: 'en', country: 'GB' }

      for (const term of ['trail shoes', 'wide trail shoes', 'best trail shoes']) {
        await harness.pool.query(
          `insert into keywords (account_id, term, language, country, source, confirmed)
           values ($1, $2, 'en', 'GB', 'auto', true)`,
          [mine, term],
        )
        await upsertSerpSnapshot(harness.db, system, {
          cacheKey: serpSnapshotKey({ query: term, locale, depth: 10 }),
          query: term,
          locale: 'en-GB',
          results: [
            { position: 2, url: `https://rival-shoes.com/${term}`, domain: 'rival-shoes.com', title: null },
          ],
          fetchedAt: new Date('2026-08-01T00:00:00Z'),
          expiresAt: new Date('2026-08-08T00:00:00Z'),
        })
      }

      expect(
        await competitorSuggestions(deps, scope, new Date('2026-09-03T00:00:00Z')),
      ).toEqual([])
    })
  })
})
