import { sql } from 'drizzle-orm'
import { db as defaultDb, type Db } from './client'

/**
 * The cheapest question that only a reachable, answering database can answer.
 *
 * Deliberately not a table read: a probe that touches a table starts failing
 * for reasons that are not "the database is down" — a migration mid-flight, a
 * lock someone else holds — and a health check that fails for reasons the
 * platform cannot fix by restarting is worse than none.
 */

/**
 * A refused connection fails immediately, but a host that accepts the socket and
 * never answers hangs — so the probe would hang too, and the platform would see
 * a timeout rather than an unhealthy answer. This bounds it well inside the
 * platform's own health-check timeout, so we get to say *why* we are unhealthy.
 */
const PING_TIMEOUT_MS = 5_000

export async function pingDatabase(database: Db = defaultDb(), timeoutMs = PING_TIMEOUT_MS): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`the database did not answer within ${timeoutMs}ms`)), timeoutMs)
    // Never keep the process alive for a probe that has already been answered.
    timer.unref?.()
  })
  try {
    await Promise.race([database.execute(sql`select 1`), expiry])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
