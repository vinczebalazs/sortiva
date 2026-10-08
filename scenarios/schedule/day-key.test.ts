import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setMerchantPause } from '../../core/settings.ts'
import { homeQueue, skipTopic } from '../../core/topics/queue.ts'
import { storesDueForPick } from '../../jobs/topics.ts'
import { startPipeline, type Pipeline } from '../pipeline.ts'

let p: Pipeline
beforeAll(async () => {
  p = await startPipeline()
})
afterAll(() => p?.stop())

async function setUp(name: string) {
  const store = await p.install(name)
  await p.settle()
  await p.completeSetup(store.id)
  await p.settle()
  return store
}

async function days(storeId: number) {
  const { rows } = await p.db.pool.query(
    `select to_char(local_date, 'YYYY-MM-DD') as date, outcome, topic_id::int as topic, reason from schedule_days where store_id = $1 order by local_date`,
    [storeId],
  )
  return rows
}

const sweep = async (at: string) => {
  await p.worker.addJob('daily_sweep', { at })
  await p.settle()
}

describe('the day key is the store-local calendar day', () => {
  it('a New York store publishing at 23:00 is picked on its own date, once, even when UTC has moved to the next day', async () => {
    const ny = await setUp('three-en')
    await p.db.pool.query(`update stores set publish_hour = 23 where id = $1`, [ny.id])

    // 03:30 UTC on 8 October is 23:30 on 7 October in New York.
    expect(await storesDueForPick(p.db.pool, new Date('2026-10-08T03:30:00Z'))).toEqual([{ storeId: ny.id, localDate: '2026-10-07' }])
    expect(await storesDueForPick(p.db.pool, new Date('2026-10-08T04:10:00Z'))).toEqual([])

    await sweep('2026-10-08T03:05:00Z')
    await sweep('2026-10-08T03:55:00Z')
    const after = await days(ny.id)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ date: '2026-10-07', outcome: 'scheduled' })

    // The next local evening takes the next topic: one per day, never two on one day.
    await sweep('2026-10-09T03:30:00Z')
    const two = await days(ny.id)
    expect(two.map((d) => d.date)).toEqual(['2026-10-07', '2026-10-08'])
    const { rows } = await p.db.pool.query(`select count(*)::int as n from topics where store_id = $1 and state = 'scheduled'`, [ny.id])
    expect(rows[0].n).toBe(two.filter((d) => d.outcome === 'scheduled').length)
  })

  it('a pick re-run for a day already decided returns that decision and takes nothing more', async () => {
    const ny = await p.storeId('tidewell-candles.myshopify.com')
    const before = await days(ny)
    await p.worker.addJob('daily_pick', { storeId: ny, localDate: '2026-10-07' })
    await p.settle()
    expect(await days(ny)).toEqual(before)
  })
})

describe('a paused store is skipped with a visible reason', () => {
  it('paused by the merchant: the day is recorded as skipped, Home says why, and no expected dates are shown', async () => {
    const store = await setUp('three-hu')
    await setMerchantPause(p.db.pool, store.id, true)
    // 07:00 UTC is 09:00 in Budapest, the default publish hour.
    await sweep('2026-10-08T07:00:00Z')
    expect(await days(store.id)).toEqual([{ date: '2026-10-08', outcome: 'skipped', topic: null, reason: 'paused_by_merchant' }])
    const home = await homeQueue(p.db.pool, store.id, new Date('2026-10-08T07:30:00Z'))
    expect(home.today).toEqual({ kind: 'nothing', reason: 'paused_by_merchant' })
    for (const t of home.upNext) expect(t.expectedDate).toBeNull()
    await setMerchantPause(p.db.pool, store.id, false)
  })

  it('unpaused, the queue shows a date per position from tomorrow on, and "Skip this one" leaves today empty without back-filling', async () => {
    const store = await p.storeId('mezeskert.myshopify.com')
    const home = await homeQueue(p.db.pool, store, new Date('2026-10-09T05:00:00Z'))
    expect(home.today.kind).toBe('scheduled')
    home.upNext.forEach((t, i) => expect(t.expectedDate).toBe(`2026-10-${String(10 + i).padStart(2, '0')}`))

    await sweep('2026-10-09T07:00:00Z')
    const [, day] = await days(store)
    expect(day).toMatchObject({ date: '2026-10-09', outcome: 'scheduled' })
    expect(await skipTopic(p.db.pool, store, day!.topic)).toBe(true)
    const after = await homeQueue(p.db.pool, store, new Date('2026-10-09T08:00:00Z'))
    expect(after.today).toEqual({ kind: 'nothing', reason: 'skipped_by_merchant' })
    await sweep('2026-10-09T07:40:00Z')
    expect((await days(store)).filter((d) => d.date === '2026-10-09')).toHaveLength(1)
  })
})

describe('topic-finding goes out again when the queue runs low', () => {
  it('after the daily pick leaves fewer than five waiting and the last search is over a week old', async () => {
    const store = await p.storeId('tidewell-candles.myshopify.com')
    await p.db.pool.query(`update stores set topics_discovered_at = now() - interval '8 days' where id = $1`, [store])
    const runsBefore = await p.db.pool.query(`select count(*)::int as n from job_ledger where task = 'find_topics' and store_id = $1`, [store])
    await sweep('2026-10-10T03:30:00Z')
    const runsAfter = await p.db.pool.query(`select count(*)::int as n from job_ledger where task = 'find_topics' and store_id = $1`, [store])
    expect(runsAfter.rows[0].n).toBe(runsBefore.rows[0].n + 1)
  })
})
