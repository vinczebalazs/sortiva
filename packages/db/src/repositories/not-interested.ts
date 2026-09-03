import { eq } from 'drizzle-orm'
import type { Db } from '../client'
import { notInterested } from '../schema'
import type { AccountScope } from '../scope'

/**
 * The calendar's veto list, main §8.7: "deleted topics go to a
 * 'not interested' list that replenishment consults, so a vetoed topic is
 * never re-proposed." One row per fingerprint (`packages/core/src/calendar/fingerprint.ts`);
 * on-conflict-do-nothing because a merchant vetoing the same candidate twice
 * (once as an auto topic, later as a manual re-add) is not an error.
 */
export async function insertNotInterested(
  db: Db,
  scope: AccountScope,
  fingerprint: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(notInterested)
    .values({ accountId: scope.accountId, topicFingerprint: fingerprint, vetoedAt: now })
    .onConflictDoNothing()
}

export async function notInterestedFingerprints(
  db: Db,
  scope: AccountScope,
): Promise<Set<string>> {
  const rows = await db
    .select({ topicFingerprint: notInterested.topicFingerprint })
    .from(notInterested)
    .where(eq(notInterested.accountId, scope.accountId))
  return new Set(rows.map((r) => r.topicFingerprint))
}
