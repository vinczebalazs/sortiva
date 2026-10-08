import { afterAll, beforeAll, expect, it } from 'vitest'
import { homeState } from '../../core/screens.ts'
import { startPipeline, type Pipeline } from '../pipeline.ts'

let p: Pipeline
beforeAll(async () => {
  p = await startPipeline({ writing: false })
})
afterAll(() => p?.stop())

it('when DataForSEO cannot answer, Home says so plainly instead of "finding topics" forever, and the next daily run recovers', async () => {
  const store = await p.install('three-hu')
  await p.settle()
  p.dataforseo.script({ failWith: 40210 })
  await p.completeSetup(store.id)
  await p.settle()

  const failed = await homeState(p.db.pool, store.id, new Date('2026-10-08T05:00:00Z'))
  expect(failed.topicsUnavailable).toBe(true)
  expect(failed.findingTopics).toBe(false)
  expect(failed.today).toEqual({ kind: 'nothing', reason: 'queue_empty' })
  const { rows } = await p.db.pool.query(`select topics_failure from store_flags where store_id = $1`, [store.id])
  // The vendor's reason is kept for us; the merchant's line names no vendor.
  expect(rows[0].topics_failure).toMatch(/40210/)
  expect(await p.banners(store.id)).toEqual([])

  // Retries run out within the minute; recovery comes from the next daily run, at 09:00 Budapest time.
  p.dataforseo.script({})
  await p.worker.addJob('daily_sweep', { at: '2026-10-09T07:00:00Z' })
  await p.settle()
  const recovered = await homeState(p.db.pool, store.id, new Date('2026-10-08T05:00:00Z'))
  expect(recovered.topicsUnavailable).toBe(false)
  expect(recovered.today.kind === 'scheduled' || recovered.upNext.length > 0).toBe(true)
})
