import { pauseOn } from '../core/learn/sync.ts'
import { StorePausedError, pauseReason } from '../core/status.ts'
import { writeArticle, type WriteOutcome } from '../core/write/write.ts'
import type { Db } from '../db/pool.ts'
import type { Deps } from './deps.ts'
import { idempotencyKey } from './runtime/keys.ts'
import { defineJob, enqueue } from './runtime/task.ts'

type WritePayload = { storeId: number; topicId: number; localDate: string }

export async function requestWrite(db: Db, payload: WritePayload): Promise<void> {
  await enqueue(db, writeArticleJob.name, payload, { jobKey: `write_article:${payload.storeId}:${payload.topicId}:${payload.localDate}`, jobKeyMode: 'unsafe_dedupe' })
}

export const writeArticleJob = defineJob<WritePayload, Deps>({
  name: 'write_article',
  storeId: (p) => p.storeId,
  idempotencyKey: (p) => idempotencyKey('write_article', p.storeId, String(p.topicId), { localDate: p.localDate }),
  run: async ({ deps, payload: { storeId, topicId, localDate } }) => {
    const { rows } = await deps.pool.query<{ state: string }>(`select state from topics where id = $1 and store_id = $2`, [topicId, storeId])
    if (rows[0]?.state !== 'scheduled') return { skipped: rows[0]?.state ?? 'missing' }
    let outcome: WriteOutcome
    try {
      outcome = await pauseOn(deps.pool, storeId, () => writeArticle({ db: deps.pool, llm: deps.llm }, storeId, topicId))
    } catch (error) {
      // Retried by the queue; once retries run out, the next daily pick puts the topic back at the top.
      if (!(error instanceof StorePausedError)) {
        await deps.pool.query(`update store_flags set write_failed_at = now(), write_failure = $2 where store_id = $1`, [storeId, String((error as Error).message).slice(0, 500)])
      }
      throw error
    }
    await deps.pool.query(`update store_flags set write_failed_at = null, write_failure = null where store_id = $1`, [storeId])
    if (outcome.outcome === 'held') await tryAnotherToday(deps.pool, storeId, localDate)
    return outcome
  },
})

/**
 * A held article gives the day one more topic (founder, 2026-10-08). Only one: the extra topic is
 * recorded on the day's row, and a second hold ends the day.
 */
export async function tryAnotherToday(pool: Db, storeId: number, localDate: string): Promise<number | null> {
  const client = await pool.connect()
  let topicId: number | null = null
  try {
    await client.query('begin')
    const { rows: days } = await client.query<{ retry_topic_id: number | null }>(
      `select retry_topic_id::int from schedule_days where store_id = $1 and local_date = $2 and outcome = 'scheduled' for update`,
      [storeId, localDate],
    )
    if (days[0] && days[0].retry_topic_id === null && !(await pauseReason(client, storeId))) {
      const { rows } = await client.query<{ id: number }>(
        `select id::int from topics where store_id = $1 and state = 'queued' order by manual_position asc nulls last, rank desc, id limit 1 for update`,
        [storeId],
      )
      if (rows[0]) {
        topicId = rows[0].id
        await client.query(`update topics set state = 'scheduled', scheduled_for = $2, manual_position = null where id = $1`, [topicId, localDate])
        await client.query(`update schedule_days set retry_topic_id = $3 where store_id = $1 and local_date = $2`, [storeId, localDate, topicId])
      }
    }
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
  if (topicId !== null) await requestWrite(pool, { storeId, topicId, localDate })
  return topicId
}
