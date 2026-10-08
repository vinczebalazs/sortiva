import { afterAll, beforeAll, expect, it } from 'vitest'
import { storesDueForNightly } from '../../jobs/sweepers.ts'
import { startPipeline, type Pipeline } from '../pipeline.ts'

let p: Pipeline
beforeAll(async () => {
  p = await startPipeline()
})
afterAll(() => p?.stop())

it('the nightly re-read picks each store in its own night, once per local day', async () => {
  const budapest = await p.install('three-hu')
  const newYork = await p.install('three-en')
  await p.settle()

  const due = async (iso: string) => (await storesDueForNightly(p.db.pool, new Date(iso))).map((d) => d.storeId)
  // 01:00 UTC on 8 October is 03:00 in Budapest (summer time) and 21:00 the day before in New York.
  expect(await due('2026-10-08T01:30:00Z')).toEqual([budapest.id])
  expect(await due('2026-10-08T07:10:00Z')).toEqual([newYork.id])
  expect(await due('2026-10-08T12:00:00Z')).toEqual([])

  const pagesBefore = p.shopify.requests.filter((r) => r.operation === 'ProductsPage' && r.shop === budapest.domain).length
  await p.worker.addJob('nightly_sweep', { at: '2026-10-08T01:30:00Z' })
  await p.worker.addJob('nightly_sweep', { at: '2026-10-08T01:45:00Z' })
  await p.settle()
  const pages = p.shopify.requests.filter((r) => r.operation === 'ProductsPage' && r.shop === budapest.domain).length - pagesBefore
  expect(pages).toBe(1)
})
