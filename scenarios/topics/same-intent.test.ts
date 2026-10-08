import { afterAll, beforeAll, expect, it } from 'vitest'
import { startPipeline, type Pipeline } from '../pipeline.ts'

let p: Pipeline
beforeAll(async () => {
  p = await startPipeline()
})
afterAll(() => p?.stop())

it('two candidates Google answers with the same top three are one intent: only the higher-demand one is queued', async () => {
  const shared = ['https://one.example/guide', 'https://two.example/guide', 'https://three.example/guide']
  p.dataforseo.script({
    serp: (keyword) => [...shared, ...Array.from({ length: 7 }, (_, i) => `https://other-${i}.example/${encodeURIComponent(keyword)}`)].map((url) => ({ url })),
  })
  const store = await p.install('rich-en')
  await p.settle()
  await p.completeSetup(store.id)
  await p.settle()

  const { rows } = await p.db.pool.query(`select target_query, demand from topics where store_id = $1 and state = 'queued'`, [store.id])
  const outcome = await p.lastDiscovery(store.id)
  if (!outcome.ran) throw new Error(`discovery did not run: ${outcome.why}`)
  const collapsed = outcome.dropped.filter((d) => d.reason === 'same_intent')
  expect(rows).toHaveLength(1)
  expect(collapsed.length).toBeGreaterThan(0)
  for (const d of collapsed) {
    expect(d.detail).toBe(rows[0].target_query)
    expect(rows[0].demand).toBeGreaterThanOrEqual(d.searches!)
  }
})
