import type { Db, DbClient } from '../../db/pool.ts'
import { pauseReason, type PauseReason } from '../status.ts'
import { whyLine, type Evidence, type WhyLine } from './evidence.ts'

export type QueueProduct = { id: number; title: string; image: string | null }

export type QueuedTopic = {
  id: number
  workingTitle: string
  targetQuery: string
  searches: number | null
  source: 'discovery' | 'manual'
  products: QueueProduct[]
  why: WhyLine
  /** The store-local day it would be written; null while the store is paused. */
  expectedDate: string | null
}

/** An article written today, in the order it was tried: at most the day's topic and one more after a hold. */
export type TodayArticle = { id: number; title: string; status: string; heldReason: string | null }

export type Today =
  | { kind: 'nothing'; reason: 'queue_empty' | 'publish_hour_passed' | 'skipped_by_merchant' | PauseReason }
  | { kind: 'scheduled'; topic: QueuedTopic; decided: boolean; articles: TodayArticle[] }

type TopicRow = {
  id: number
  working_title: string
  target_query: string
  demand: number | null
  source: 'discovery' | 'manual'
  evidence: Evidence
  products: { id: number; title: string; images: { url: string }[] }[]
}

const TOPIC_COLUMNS = `t.id::int, t.working_title, t.target_query, t.demand, t.source, t.evidence,
  coalesce((select json_agg(json_build_object('id', p.id, 'title', p.title, 'images', p.images) order by array_position(t.product_ids, p.id))
            from products p where p.id = any(t.product_ids) and p.deleted_at is null), '[]') as products`

// Merchant-placed topics first (lower position is higher), then by rank.
const QUEUE_ORDER = `t.manual_position asc nulls last, t.rank desc, t.id`

function toTopic(row: TopicRow, expectedDate: string | null): QueuedTopic {
  return {
    id: row.id,
    workingTitle: row.working_title,
    targetQuery: row.target_query,
    searches: row.demand,
    source: row.source,
    products: row.products.map((p) => ({ id: p.id, title: p.title, image: p.images[0]?.url ?? null })),
    why: whyLine(row.evidence, row.source),
    expectedDate,
  }
}

type Clock = { local_date: string; local_hour: number; publish_hour: number }

async function clock(db: DbClient, storeId: number, now: Date): Promise<Clock> {
  const { rows } = await db.query<Clock>(
    `select to_char(($2::timestamptz at time zone timezone)::date, 'YYYY-MM-DD') as local_date,
            extract(hour from ($2::timestamptz at time zone timezone))::int as local_hour, publish_hour
     from stores where id = $1`,
    [storeId, now],
  )
  return rows[0]!
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * What Home shows: today's slot and the queue after it. Position n in "Up next" is written n days
 * from today, since today's slot is shown separately and a day without a topic is never back-filled.
 */
export async function homeQueue(db: Db, storeId: number, now = new Date()): Promise<{ today: Today; upNext: QueuedTopic[] }> {
  const c = await clock(db, storeId, now)
  const pause = await pauseReason(db, storeId)
  const { rows: queued } = await db.query<TopicRow>(`select ${TOPIC_COLUMNS} from topics t where t.store_id = $1 and t.state = 'queued' order by ${QUEUE_ORDER}`, [storeId])
  const { rows: days } = await db.query<{ outcome: string; reason: string | null; topic_id: number | null; retry_topic_id: number | null }>(
    `select outcome, reason, topic_id::int, retry_topic_id::int from schedule_days where store_id = $1 and local_date = $2`,
    [storeId, c.local_date],
  )
  const decided = days[0]
  const pausedForGood = pause !== null && pause !== 'budget'
  const dated = (rows: TopicRow[]) => rows.map((r, i) => toTopic(r, pausedForGood ? null : addDays(c.local_date, i + 1)))

  let today: Today
  let rest = queued
  if (decided?.outcome === 'scheduled' && decided.topic_id) {
    const { rows } = await db.query<TopicRow>(`select ${TOPIC_COLUMNS} from topics t where t.id = $1`, [decided.retry_topic_id ?? decided.topic_id])
    const { rows: articles } = await db.query<TodayArticle>(
      `select a.id::int, coalesce(a.title, t.working_title) as title, a.state as status, t.held_reason as "heldReason"
       from articles a join topics t on t.id = a.topic_id
       where a.topic_id = any($1::bigint[]) and a.state <> 'discarded' order by array_position($1::bigint[], a.topic_id)`,
      [[decided.topic_id, decided.retry_topic_id].filter((id) => id !== null)],
    )
    today = { kind: 'scheduled', topic: toTopic(rows[0]!, c.local_date), decided: true, articles }
  } else if (decided) {
    today = { kind: 'nothing', reason: (decided.reason ?? 'queue_empty') as Extract<Today, { kind: 'nothing' }>['reason'] }
  } else if (pause) {
    today = { kind: 'nothing', reason: pause }
  } else if (c.local_hour >= c.publish_hour) {
    today = { kind: 'nothing', reason: 'publish_hour_passed' }
  } else if (queued[0]) {
    today = { kind: 'scheduled', topic: toTopic(queued[0], c.local_date), decided: false, articles: [] }
    rest = queued.slice(1)
  } else {
    today = { kind: 'nothing', reason: 'queue_empty' }
  }
  return { today, upNext: dated(rest) }
}

async function topicOf(db: DbClient, storeId: number, topicId: number): Promise<{ canonical_key: string; state: string } | null> {
  const { rows } = await db.query<{ canonical_key: string; state: string }>('select canonical_key, state from topics where id = $1 and store_id = $2', [topicId, storeId])
  return rows[0] ?? null
}

/** Removes the topic for good: its key goes on the not-interested list, which discovery never re-proposes. */
export async function notInterested(db: Db, storeId: number, topicId: number): Promise<boolean> {
  const topic = await topicOf(db, storeId, topicId)
  if (!topic || (topic.state !== 'queued' && topic.state !== 'scheduled' && topic.state !== 'candidate')) return false
  await db.query(`update topics set state = 'vetoed', manual_position = null where id = $1`, [topicId])
  await db.query(`insert into not_interested (store_id, canonical_key) values ($1, $2) on conflict do nothing`, [storeId, topic.canonical_key])
  await db.query(`update schedule_days set outcome = 'skipped', reason = 'skipped_by_merchant' where store_id = $1 and topic_id = $2 and outcome = 'scheduled'`, [storeId, topicId])
  return true
}

export async function moveToTop(db: DbClient, storeId: number, topicId: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `update topics set manual_position = coalesce((select min(manual_position) from topics where store_id = $1 and state = 'queued'), 1) - 1
     where id = $2 and store_id = $1 and state = 'queued'`,
    [storeId, topicId],
  )
  return Boolean(rowCount)
}

/**
 * "Skip this one": out of the queue without a veto, so a later discovery may propose it again.
 * If it already held today's slot, today stays empty; the day is never back-filled.
 */
export async function skipTopic(db: Db, storeId: number, topicId: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `update topics set state = 'candidate', manual_position = null, scheduled_for = null where id = $1 and store_id = $2 and state in ('queued', 'scheduled')`,
    [topicId, storeId],
  )
  if (!rowCount) return false
  await db.query(`update schedule_days set outcome = 'skipped', reason = 'skipped_by_merchant' where store_id = $1 and topic_id = $2 and outcome = 'scheduled'`, [storeId, topicId])
  return true
}
