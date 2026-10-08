import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CONFIG } from '../../core/config.ts'
import { canonicalKey } from '../../core/topics/canonical.ts'
import { ENDPOINTS } from '../../vendors/dataforseo/prices.ts'
import { startPipeline, type Pipeline } from '../pipeline.ts'

let p: Pipeline
beforeAll(async () => {
  p = await startPipeline()
})
afterAll(() => p?.stop())

async function topics(storeId: number) {
  const { rows } = await p.db.pool.query(
    `select canonical_key, target_query, language, state, demand, product_ids::int[] as product_ids, evidence from topics where store_id = $1 order by id`,
    [storeId],
  )
  return rows
}

describe.each([
  ['rich-en', 'en', 'GB', 2826],
  ['rich-hu', 'hu', 'HU', 2348],
] as const)('%s', (name, language, country, location) => {
  it('finds topics after setup, and finding them again adds no duplicate', async () => {
    const store = await p.install(name)
    await p.settle()
    await p.completeSetup(store.id)
    await p.settle()
    const first = await topics(store.id)
    expect(first.length).toBeGreaterThan(0)

    await p.rediscover(store.id)
    await p.settle()
    const second = await topics(store.id)
    const keys = second.map((t) => t.canonical_key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const t of second) expect(canonicalKey(t.target_query, language)).toBe(t.canonical_key)
    // Everything from the first run is still there, unchanged in identity.
    expect(second.map((t) => t.canonical_key)).toEqual(expect.arrayContaining(first.map((t) => t.canonical_key)))
  })

  it(`is priced on ${country} demand in ${language}, and every topic carries its numbers with their source`, async () => {
    const store = await p.storeId(name === 'rich-en' ? 'fernhill-coffee.myshopify.com' : 'bukki-fuveshaz.myshopify.com')
    const asked = p.dataforseo.requests.filter((r) => r.endpoint === ENDPOINTS.searchVolume && (r.task.keywords as string[]).some((k) => k))
    const { rows: calls } = await p.db.pool.query(`select request from vendor_calls where store_id = $1`, [store])
    expect(calls.length).toBeGreaterThan(0)
    for (const { request } of calls) expect(request).toMatchObject({ location_code: location, language_code: language })
    expect(asked.length).toBeGreaterThan(0)

    for (const t of await topics(store)) {
      expect(t.language).toBe(language)
      expect(t.demand).toBeGreaterThanOrEqual(CONFIG.demandFloor[language])
      expect(t.evidence.searches).toMatchObject({ value: t.demand, country, language, source: `dataforseo:${ENDPOINTS.searchVolume}` })
      expect(t.evidence.facts.value).toBeGreaterThan(0)
      expect(t.evidence.topResults.top3).toHaveLength(3)
    }
  })

  it('asks for every candidate phrase in one demand request per run', async () => {
    const store = await p.storeId(name === 'rich-en' ? 'fernhill-coffee.myshopify.com' : 'bukki-fuveshaz.myshopify.com')
    const { rows } = await p.db.pool.query(
      `select count(*)::int as n from vendor_calls where store_id = $1 and endpoint = $2`,
      [store, ENDPOINTS.searchVolume],
    )
    const { rows: runs } = await p.db.pool.query(`select count(*)::int as n from job_ledger where store_id = $1 and task = 'find_topics'`, [store])
    expect(rows[0].n).toBeLessThanOrEqual(runs[0].n)
  })
})

describe('the thin-store cap', () => {
  it.each(['three-en', 'three-hu'])('%s: three products yield at most three topics, each about products we hold facts for', async (name) => {
    const store = await p.install(name)
    await p.settle()
    await p.completeSetup(store.id)
    await p.settle()
    const list = await topics(store.id)
    const state = await p.thinState(store.id)
    expect(state.thin).toBe(true)
    expect(list.filter((t) => t.state === 'queued').length).toBeLessThanOrEqual(Math.min(3, state.usable))
    const { rows: usable } = await p.db.pool.query(`select id::int from products where store_id = $1 and richness >= $2`, [store.id, CONFIG.minFactsPerProduct])
    const usableIds = usable.map((u) => u.id)
    for (const t of list) {
      expect(t.product_ids.length).toBeGreaterThan(0)
      for (const id of t.product_ids) expect(usableIds).toContain(id)
    }
  })

  it('a store whose products give us nothing to say gets at most one topic per usable product', async () => {
    const store = await p.install('fluff-en')
    await p.settle()
    await p.completeSetup(store.id)
    await p.settle()
    const list = (await topics(store.id)).filter((t) => t.state === 'queued')
    expect(list.length).toBeLessThanOrEqual(1)
  })
})
