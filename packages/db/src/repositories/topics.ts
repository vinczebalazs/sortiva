import { eq, and } from 'drizzle-orm'
import type { Db } from '../client'
import { topics } from '../schema'
import type { AccountScope } from '../scope'

export type TopicRow = typeof topics.$inferSelect

export interface TopicInput {
  readonly opportunityId: string
  readonly title: string
  readonly targetKeyword: string | null
  readonly keywordCluster: string | null
  readonly intentClass: TopicRow['intentClass']
  readonly familyIds: readonly string[]
  readonly kind: TopicRow['kind']
  readonly source: TopicRow['source']
  /** The template key Gate 1 (or the scoring record) rendered this from — see DECISIONS 2026-09-03 T4.1 on why this column holds a key, not prose. */
  readonly whyLine: string
  readonly scheduledDate: string
  readonly pinned: boolean
  readonly state: TopicRow['state']
}

export async function insertTopic(
  db: Db,
  scope: AccountScope,
  input: TopicInput,
  now: Date = new Date(),
): Promise<TopicRow> {
  const [row] = await db
    .insert(topics)
    .values({
      accountId: scope.accountId,
      opportunityId: input.opportunityId,
      title: input.title,
      targetKeyword: input.targetKeyword,
      keywordCluster: input.keywordCluster,
      intentClass: input.intentClass,
      familyIds: [...input.familyIds],
      kind: input.kind,
      source: input.source,
      whyLine: input.whyLine,
      scheduledDate: input.scheduledDate,
      pinned: input.pinned,
      state: input.state,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!row) throw new Error('failed to insert the topic')
  return row
}

export async function findTopic(db: Db, scope: AccountScope, topicId: string): Promise<TopicRow | undefined> {
  const [row] = await db
    .select()
    .from(topics)
    .where(and(eq(topics.accountId, scope.accountId), eq(topics.id, topicId)))
    .limit(1)
  return row
}
