import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Demand } from '../../core/demand.ts'
import { coveringPage } from '../../core/topics/check.ts'
import { topicContext } from '../../core/topics/discover.ts'
import { addManualTopic } from '../../core/topics/manual.ts'
import { homeQueue, notInterested } from '../../core/topics/queue.ts'
import { startPipeline, type Pipeline } from '../pipeline.ts'

let p: Pipeline
beforeAll(async () => {
  p = await startPipeline()
})
afterAll(() => p?.stop())

const topicDeps = () => ({ db: p.db.pool, llm: p.deps.llm, demand: p.deps.demand })

async function queued(storeId: number) {
  const { rows } = await p.db.pool.query(
    `select id::int, canonical_key, target_query, demand, source, evidence from topics where store_id = $1 and state = 'queued' order by id`,
    [storeId],
  )
  return rows
}

async function setUp(name: string) {
  const store = await p.install(name)
  await p.settle()
  await p.completeSetup(store.id)
  await p.settle()
  return store
}

describe('a candidate the store already has a page about is dropped', () => {
  it.each([
    ['blog-en', 'how to choose a dog harness'],
    ['blog-hu', 'hogyan válassz kerékpárlámpát'],
  ] as const)('%s: no queued topic competes with an existing post, and asking for one is answered with that post', async (name, existingTitle) => {
    const store = await setUp(name)
    const language = name.endsWith('-hu') ? 'hu' : 'en'
    const ctx = (await topicContext(p.db.pool, store.id))!
    for (const t of await queued(store.id)) expect(coveringPage(t.target_query, language, ctx.pages, ctx.storeWords), t.target_query).toBeNull()

    const outcome = await addManualTopic(topicDeps(), store.id, existingTitle)
    expect(outcome).toMatchObject({ kind: 'existing_page' })
  })
})

describe('a vetoed topic is not proposed again', () => {
  it('"Not interested" puts the topic on the list, and the next discovery leaves it out', async () => {
    const store = await setUp('rich-hu')
    const [first] = await queued(store.id)
    expect(first).toBeDefined()
    expect(await notInterested(p.db.pool, store.id, first!.id)).toBe(true)

    await p.rediscover(store.id)
    await p.settle()
    const after = await queued(store.id)
    expect(after.map((t) => t.canonical_key)).not.toContain(first!.canonical_key)
    const { rows } = await p.db.pool.query(`select canonical_key from not_interested where store_id = $1`, [store.id])
    expect(rows.map((r) => r.canonical_key)).toContain(first!.canonical_key)
  })
})

describe('a spending cap hit mid-discovery pauses the store', () => {
  it('stops before the demand call, queues nothing, shows the budget banner, and does not retry', async () => {
    const store = await p.install('three-en')
    await p.settle()
    const real = p.deps.demand
    const capped: Demand = {
      searchVolumes: async (request) => {
        await p.db.pool.query(
          `insert into vendor_calls (store_id, vendor, endpoint, request_hash, request, estimated_cost_usd, status, cost_usd)
           values ($1, 'test', 'earlier-spend', 'earlier-spend', '{}', 9.99, 'done', 9.99)`,
          [request.storeId],
        )
        return real.searchVolumes(request)
      },
      topResults: (request) => real.topResults(request),
    }
    p.deps.demand = capped
    try {
      await p.completeSetup(store.id)
      await p.settle()
    } finally {
      p.deps.demand = real
    }
    expect(await queued(store.id)).toEqual([])
    expect(await p.banners(store.id)).toContainEqual({ kind: 'budget_reached' })
    const { rows: jobs } = await p.db.pool.query(`select count(*)::int as n from graphile_worker.jobs where task_identifier = 'find_topics' and key = $1`, [`find_topics:${store.id}`])
    expect(jobs[0].n).toBe(0)
    const { rows: ledger } = await p.db.pool.query(`select count(*)::int as n from job_ledger where task = 'find_topics' and store_id = $1`, [store.id])
    expect(ledger[0].n).toBe(0)
    expect((await homeQueue(p.db.pool, store.id)).today).toEqual({ kind: 'nothing', reason: 'budget' })
  })
})

describe('Add a topic', () => {
  it('a topic the store can back goes to the top of the queue; asking again moves it there instead of adding it twice', async () => {
    const store = await setUp('rich-en')
    const before = await queued(store.id)
    const added = await addManualTopic(topicDeps(), store.id, 'how to clean a burr coffee grinder')
    expect(added).toMatchObject({ kind: 'added' })
    const home = await homeQueue(p.db.pool, store.id, new Date('2026-10-08T06:00:00Z'))
    const top = home.today.kind === 'scheduled' ? home.today.topic : home.upNext[0]
    expect(top!.id).toBe((added as { topicId: number }).topicId)
    expect(top!.source).toBe('manual')

    const again = await addManualTopic(topicDeps(), store.id, 'how to clean a burr coffee grinder')
    expect(again).toEqual({ kind: 'moved', topicId: (added as { topicId: number }).topicId })
    expect((await queued(store.id)).length).toBe(before.length + 1)
  })

  it('a topic only fluff products relate to is refused, naming the products that need facts', async () => {
    const store = await setUp('fluff-en')
    const outcome = await addManualTopic(topicDeps(), store.id, 'how to style a throw blanket on a sofa')
    expect(outcome.kind).toBe('cannot_back')
    expect((outcome as { products: { title: string }[] }).products.map((x) => x.title)).toContain('Serenity Throw')
  })
})
