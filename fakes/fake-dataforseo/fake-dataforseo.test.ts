import { readdirSync, readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DemandUnavailableError } from '../../core/demand.ts'
import { createTestDb, type TestDb } from '../../db/test-db.ts'
import { DataForSeoDemand, isProductListing } from '../../vendors/dataforseo/client.ts'
import { ENDPOINTS } from '../../vendors/dataforseo/prices.ts'
import { shapeDifferences } from '../shared/shape.ts'
import { startFakeDataForSeo, type FakeDataForSeo, type Recording } from './server.ts'

let db: TestDb
let fake: FakeDataForSeo
let demand: DataForSeoDemand
let storeId: number

beforeAll(async () => {
  db = await createTestDb()
  fake = await startFakeDataForSeo()
  demand = new DataForSeoDemand(db.pool, { login: fake.login, password: fake.password, baseUrl: fake.url })
  const { rows } = await db.pool.query(`insert into stores (shop_domain) values ('demand.myshopify.com') returning id`)
  storeId = rows[0].id
  await db.pool.query('insert into store_flags (store_id) values ($1)', [storeId])
})
afterAll(async () => {
  await fake?.close()
  await db?.drop()
})

const sample = (name: string) => JSON.parse(readFileSync(new URL(`./published-samples/${name}`, import.meta.url), 'utf8')).response
const hu = { country: 'HU', language: 'hu' as const }

describe('fake DataForSEO answers in the published form', () => {
  it('search volume matches the documented example field for field', async () => {
    fake.script({ volume: (k) => (k === 'kamillatea' ? 1900 : undefined) })
    const res = await fetch(`${fake.url}/v3/${ENDPOINTS.searchVolume}`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(`${fake.login}:${fake.password}`).toString('base64') },
      body: JSON.stringify([{ keywords: ['kamillatea'], location_code: 2348, language_code: 'hu' }]),
    })
    const body = await res.json()
    const real = sample('search_volume.json')
    delete body.tasks[0].data
    delete real.tasks[0].data
    expect(shapeDifferences(body, real)).toEqual([])
  })

  it('top results match the documented example field for field', async () => {
    fake.script({ serp: () => [{ url: 'https://a.example/x' }] })
    const res = await fetch(`${fake.url}/v3/${ENDPOINTS.topResults}`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(`${fake.login}:${fake.password}`).toString('base64') },
      body: JSON.stringify([{ keyword: 'x', location_code: 2348, language_code: 'hu', depth: 10 }]),
    })
    const body = await res.json()
    const real = sample('serp_organic.json')
    // The example mixes forty item types; ours are organic only, so compare against its organic item.
    real.tasks[0].result[0].items = real.tasks[0].result[0].items.filter((i: { type: string }) => i.type === 'organic')
    // `data` echoes whatever the request sent, so it differs by request, not by form.
    delete body.tasks[0].data
    delete real.tasks[0].data
    expect(shapeDifferences(body, real)).toEqual([])
  })

  it('every committed recording has the shape the fake produces', () => {
    const dir = new URL('./recordings/', import.meta.url)
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const recording = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as Recording
      const published = sample(recording.endpoint === ENDPOINTS.searchVolume ? 'search_volume.json' : 'serp_organic.json')
      expect(shapeDifferences(published, recording.response), file).toEqual([])
    }
  })
})

describe('the DataForSEO client', () => {
  it('asks in the store market, prices the call before sending, and answers repeats from the stored call', async () => {
    fake.script({ volume: (k) => ({ kamillatea: 1900, csalántea: 320 })[k] ?? null })
    const first = await demand.searchVolumes({ storeId, market: hu, keywords: ['Kamillatea', 'csalántea', 'kamillatea'] })
    expect(first.map((r) => [r.keyword, r.searches])).toEqual([
      ['csalántea', 320],
      ['kamillatea', 1900],
    ])
    expect(fake.requests.at(-1)!.task).toMatchObject({ location_code: 2348, language_code: 'hu' })
    const before = fake.requests.length
    await demand.searchVolumes({ storeId, market: hu, keywords: ['kamillatea', 'csalántea'] })
    expect(fake.requests.length).toBe(before)
    const { rows } = await db.pool.query(`select status, estimated_cost_usd::float8 as est, cost_usd::float8 as cost from vendor_calls where endpoint = $1`, [ENDPOINTS.searchVolume])
    expect(rows).toEqual([{ status: 'done', est: 0.09, cost: 0.09 }])
  })

  it('refetches an answer older than its limit instead of serving it', async () => {
    fake.script({ volume: () => 50 })
    await demand.searchVolumes({ storeId, market: hu, keywords: ['teafilter'] })
    await db.pool.query(`update vendor_calls set completed_at = now() - interval '31 days' where request->'keywords' ? 'teafilter'`)
    fake.script({ volume: () => 70 })
    const [reading] = await demand.searchVolumes({ storeId, market: hu, keywords: ['teafilter'] })
    expect(reading!.searches).toBe(70)
    const { rows } = await db.pool.query(`select status from vendor_calls where request->'keywords' ? 'teafilter' order by id`)
    expect(rows.map((r) => r.status)).toEqual(['superseded', 'done'])
  })

  it('reads the organic top ten and marks shop pages', async () => {
    fake.script({ serp: () => [{ url: 'https://shop.example/products/a' }, { url: 'https://blog.example/how-to', title: 'How to' }, { url: 'https://x.example/a', price: true }] })
    const top = await demand.topResults({ storeId, market: hu, keyword: 'teaszűrő' })
    expect(top.pages.map((p) => [p.rank, p.domain, p.productListing])).toEqual([
      [1, 'shop.example', true],
      [2, 'blog.example', false],
      [3, 'x.example', true],
    ])
  })

  it('stops with a named reason when DataForSEO is out of funds, and records the failed call', async () => {
    fake.script({ failWith: 40210 })
    const error = await demand.searchVolumes({ storeId, market: hu, keywords: ['méz'] }).catch((e) => e)
    expect(error).toBeInstanceOf(DemandUnavailableError)
    expect(error.outOfFunds).toBe(true)
    const { rows } = await db.pool.query(`select status from vendor_calls where request->'keywords' ? 'méz'`)
    expect(rows).toEqual([{ status: 'failed' }])
  })

  it('refuses before spending when the store cap would be passed', async () => {
    fake.script({})
    await db.pool.query(`insert into vendor_calls (store_id, vendor, endpoint, request_hash, request, estimated_cost_usd, status) values ($1, 'x', 'x', 'spent', '{}', 9.95, 'done')`, [storeId])
    const before = fake.requests.length
    await expect(demand.searchVolumes({ storeId, market: hu, keywords: ['zöld tea'] })).rejects.toThrow(/daily spending cap/)
    expect(fake.requests.length).toBe(before)
  })
})

it('a priced or shop-path result is a product listing; an article is not', () => {
  expect(isProductListing({ url: 'https://a.hu/termek/kamilla', price: null })).toBe(true)
  expect(isProductListing({ url: 'https://a.com/collections/tea', price: null })).toBe(true)
  expect(isProductListing({ url: 'https://a.com/blogs/news/tea', price: null })).toBe(false)
})
