import { afterAll, beforeAll, expect, it } from 'vitest'
import { ENDPOINTS } from '../../vendors/dataforseo/prices.ts'
import { startPipeline, type Pipeline } from '../pipeline.ts'

let p: Pipeline
beforeAll(async () => {
  p = await startPipeline()
})
afterAll(() => p?.stop())

it('each topic is proposed in several phrasings, all measured in one request, and the most searched one is kept', async () => {
  // Shorter phrasings are searched more here, so the winner is rarely the model's first guess.
  p.dataforseo.script({ volume: (keyword) => Math.max(0, 2000 - keyword.length * 40) })
  try {
    const store = await p.install('rich-hu')
    await p.settle()
    await p.completeSetup(store.id)
    await p.settle()

    const outcome = await p.lastDiscovery(store.id)
    if (!outcome.ran) throw new Error(`discovery did not run: ${outcome.why}`)
    expect(outcome.queued.length).toBeGreaterThan(0)
    expect(outcome.queued.some((q) => q.phrasings.length > 1)).toBe(true)
    for (const q of outcome.queued) {
      const most = Math.max(...q.phrasings.map((x) => x.searches ?? 0))
      expect(q.searches, q.query).toBe(most)
      expect(q.phrasings.map((x) => x.query)).toContain(q.query)
    }
    const { rows } = await p.db.pool.query(`select target_query, demand from topics where store_id = $1 and state = 'queued'`, [store.id])
    expect(rows.map((r) => r.target_query).sort()).toEqual(outcome.queued.map((q) => q.query).sort())

    const volumeRequests = p.dataforseo.requests.filter((r) => r.endpoint === ENDPOINTS.searchVolume)
    expect(volumeRequests).toHaveLength(1)
    expect((volumeRequests[0]!.task.keywords as string[]).length).toBeGreaterThan(outcome.proposed)
  } finally {
    p.dataforseo.script({})
  }
})
