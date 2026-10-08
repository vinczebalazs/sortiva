import type { Task } from 'graphile-worker'
import type { Db } from '../db/pool.ts'
import { enqueueNightlySync } from './catalog.ts'

export const NIGHTLY_LOCAL_HOUR = 3

/** Open stores whose local clock reads the nightly hour at `at`, with their local date. */
export async function storesDueForNightly(db: Db, at: Date): Promise<{ storeId: number; localDate: string }[]> {
  const { rows } = await db.query<{ id: number; local_date: string }>(
    `select id, to_char(($1::timestamptz at time zone timezone)::date, 'YYYY-MM-DD') as local_date
     from stores
     where closed_at is null and setup_step <> 'reading'
       and extract(hour from ($1::timestamptz at time zone timezone)) = $2`,
    [at, NIGHTLY_LOCAL_HOUR],
  )
  return rows.map((r) => ({ storeId: r.id, localDate: r.local_date }))
}

export function nightlySweep(db: Db): Task {
  return async (payload) => {
    const at = (payload as { at?: string } | null)?.at ? new Date((payload as { at: string }).at) : new Date()
    for (const { storeId, localDate } of await storesDueForNightly(db, at)) {
      await enqueueNightlySync(db, storeId, localDate)
    }
  }
}

// Hourly, because stores sit in different timezones; each store is picked once, in its own night and at its own publish hour.
export const CRONTAB = `0 * * * * nightly_sweep\n0 * * * * daily_sweep\n`
