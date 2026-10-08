import { afterAll, beforeAll, expect, it } from 'vitest'
import { homeState } from '../../core/screens.ts'
import { startPipeline, type Pipeline } from '../pipeline.ts'
import { articlesOf } from './seed.ts'

let p: Pipeline
beforeAll(async () => {
  p = await startPipeline()
})
afterAll(() => p?.stop())

async function setUp(name: string) {
  const store = await p.install(name)
  await p.settle()
  await p.completeSetup(store.id)
  await p.settle(300_000)
  return store.id
}

it('a topic whose products hold fewer facts than the floor is held before any writing is paid for', async () => {
  const storeId = await setUp('three-en')
  // Leave four facts in the whole store: no topic can reach six.
  await p.db.pool.query(`delete from product_facts where store_id = $1 and id not in (select id from product_facts where store_id = $1 order by id limit 4)`, [storeId])
  await p.writeToday(storeId)
  await p.settle(300_000)
  const articles = await articlesOf(p, storeId)
  expect(articles.map((a) => [a.state, a.held_reason])).toEqual([
    ['held', 'too_few_facts'],
    ['held', 'too_few_facts'],
  ])
  const { rows } = await p.db.pool.query(`select count(*)::int as n from llm_calls where store_id = $1 and prompt_name in ('plan-article', 'draft-article')`, [storeId])
  expect(rows[0].n).toBe(0)
}, 900_000)

it('when the model service is down, Home says so plainly, and the next day puts the topic back and writes it', async () => {
  const storeId = await setUp('rich-hu')
  p.anthropic.outage(true)
  const today = await p.writeToday(storeId)
  // The queue's own retries run within the half minute; later ones are left to the next day.
  await p.settle(300_000)
  const failed = await homeState(p.db.pool, storeId)
  expect(failed.writeUnavailable).toBe(true)
  expect(await p.banners(storeId)).toEqual([])
  const { rows: flags } = await p.db.pool.query(`select write_failure from store_flags where store_id = $1`, [storeId])
  expect(flags[0].write_failure).toMatch(/529|verloaded/)
  const { rows: topics } = await p.db.pool.query(`select id::int from topics where store_id = $1 and state = 'scheduled'`, [storeId])
  expect(topics).toHaveLength(1)

  p.anthropic.outage(false)
  const tomorrow = new Date(`${today}T12:00:00Z`)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  await p.writeToday(storeId, tomorrow.toISOString().slice(0, 10))
  await p.settle(900_000)
  const articles = await articlesOf(p, storeId)
  const recovered = articles.find((a) => a.topic_id === topics[0]!.id)!
  expect(recovered.state, JSON.stringify(recovered.gate_report.heldProblem)).toBe('ready')
  expect((await homeState(p.db.pool, storeId)).writeUnavailable).toBe(false)
}, 900_000)
