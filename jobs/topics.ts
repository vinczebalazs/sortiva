import type { Task } from 'graphile-worker'
import { pauseOn } from '../core/learn/sync.ts'
import { pauseReason, StorePausedError } from '../core/status.ts'
import { discoverTopics, shouldRediscover } from '../core/topics/discover.ts'
import type { Db, DbClient } from '../db/pool.ts'
import type { Deps } from './deps.ts'
import { idempotencyKey } from './runtime/keys.ts'
import { defineJob, enqueue } from './runtime/task.ts'
import { requestWrite } from './write.ts'

type FindPayload = { storeId: number; reason: 'setup' | 'low_queue' | 'profile_changed'; requestedAt: string }

export const findTopics = defineJob<FindPayload, Deps>({
  name: 'find_topics',
  storeId: (p) => p.storeId,
  idempotencyKey: (p) => idempotencyKey('find_topics', p.storeId, p.reason, { requestedAt: p.requestedAt }),
  run: async ({ deps, payload: { storeId } }) => {
    try {
      const outcome = await pauseOn(deps.pool, storeId, () => discoverTopics({ db: deps.pool, llm: deps.llm, demand: deps.demand }, storeId))
      await deps.pool.query(`update store_flags set topics_failed_at = null, topics_failure = null where store_id = $1`, [storeId])
      return outcome
    } catch (error) {
      // Retried by the queue; once retries run out, the next daily pick sends it out again.
      if (!(error instanceof StorePausedError)) {
        await deps.pool.query(`update store_flags set topics_failed_at = now(), topics_failure = $2 where store_id = $1`, [storeId, String((error as Error).message).slice(0, 500)])
      }
      throw error
    }
  },
})

export async function requestDiscovery(db: DbClient, storeId: number, reason: FindPayload['reason'], requestedAt: string): Promise<void> {
  await enqueue(db, findTopics.name, { storeId, reason, requestedAt }, { jobKey: `find_topics:${storeId}`, jobKeyMode: 'preserve_run_at' })
}

type PickPayload = { storeId: number; localDate: string }

export type DayDecision = { outcome: 'scheduled' | 'skipped' | 'empty'; topicId: number | null; reason: string | null }

/**
 * The day's one decision for a store (rule 4): take the top of the queue, or record why not.
 * Keyed on the store-local date twice over, in the job ledger and in schedule_days' primary key.
 */
export const dailyPick = defineJob<PickPayload, Deps>({
  name: 'daily_pick',
  storeId: (p) => p.storeId,
  idempotencyKey: (p) => idempotencyKey('daily_pick', p.storeId, p.localDate),
  run: async ({ deps, payload: { storeId, localDate } }) => {
    await returnUnfinished(deps.pool, storeId, localDate)
    const decision = await decideDay(deps.pool, storeId, localDate)
    if (decision.outcome === 'scheduled') await requestWrite(deps.pool, { storeId, topicId: decision.topicId!, localDate })
    if (await shouldRediscover(deps.pool, storeId)) await requestDiscovery(deps.pool, storeId, 'low_queue', localDate)
    return decision
  },
})

/**
 * A topic scheduled on an earlier day whose writing never finished (a vendor kept failing, or the
 * store paused mid-write) goes back to the queue, keeping its rank, so today's pick can take it again.
 */
export async function returnUnfinished(db: Db, storeId: number, localDate: string): Promise<void> {
  await db.query(`update topics set state = 'queued', scheduled_for = null where store_id = $1 and state = 'scheduled' and scheduled_for < $2`, [storeId, localDate])
}

export async function decideDay(pool: Db, storeId: number, localDate: string): Promise<DayDecision> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const { rows: existing } = await client.query<DayDecision>(
      `select outcome, topic_id::int as "topicId", reason from schedule_days where store_id = $1 and local_date = $2`,
      [storeId, localDate],
    )
    if (existing[0]) {
      await client.query('commit')
      return existing[0]
    }
    const pause = await pauseReason(client, storeId)
    let decision: DayDecision
    if (pause) {
      decision = { outcome: 'skipped', topicId: null, reason: pause }
    } else {
      const { rows } = await client.query<{ id: number }>(
        `select id::int from topics where store_id = $1 and state = 'queued' order by manual_position asc nulls last, rank desc, id limit 1 for update`,
        [storeId],
      )
      if (rows[0]) {
        await client.query(`update topics set state = 'scheduled', scheduled_for = $2, manual_position = null where id = $1`, [rows[0].id, localDate])
        decision = { outcome: 'scheduled', topicId: rows[0].id, reason: null }
      } else {
        decision = { outcome: 'empty', topicId: null, reason: null }
      }
    }
    await client.query(`insert into schedule_days (store_id, local_date, outcome, topic_id, reason) values ($1, $2, $3, $4, $5)`, [
      storeId,
      localDate,
      decision.outcome,
      decision.topicId,
      decision.reason,
    ])
    await client.query('commit')
    return decision
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

/** Set-up stores whose local clock reads their publish hour at `at`, with their local date. */
export async function storesDueForPick(db: Db, at: Date): Promise<{ storeId: number; localDate: string }[]> {
  const { rows } = await db.query<{ id: number; local_date: string }>(
    `select id::int, to_char(($1::timestamptz at time zone timezone)::date, 'YYYY-MM-DD') as local_date
     from stores
     where closed_at is null and setup_step = 'done'
       and extract(hour from ($1::timestamptz at time zone timezone)) = publish_hour`,
    [at],
  )
  return rows.map((r) => ({ storeId: r.id, localDate: r.local_date }))
}

export function dailySweep(db: Db): Task {
  return async (payload) => {
    const at = (payload as { at?: string } | null)?.at ? new Date((payload as { at: string }).at) : new Date()
    for (const { storeId, localDate } of await storesDueForPick(db, at)) {
      await enqueue(db, dailyPick.name, { storeId, localDate }, { jobKey: `daily_pick:${storeId}:${localDate}`, jobKeyMode: 'unsafe_dedupe' })
    }
  }
}
