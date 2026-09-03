import { eq } from 'drizzle-orm'
import type { Db } from '../client'
import { articleClaims } from '../schema'
import type { AccountScope } from '../scope'

export type ArticleClaimRow = typeof articleClaims.$inferSelect

/**
 * The claim plan, persisted — `docs/content-pointers.md` §1: every assertion
 * an article makes, enumerated and bound to its evidence, written before the
 * draft is. `packages/core/src/generation/claims.ts`'s `PlannedClaim` is the
 * in-memory shape this table stores; the two line up field for field.
 */
export interface ArticleClaimInput {
  readonly text: string
  readonly kind: ArticleClaimRow['kind']
  readonly confidence: ArticleClaimRow['confidence']
  /** One entry per piece of evidence — see `PlannedClaim.evidence`. Never empty; the table enforces it too. */
  readonly evidence: unknown
  readonly sections?: readonly string[]
}

/**
 * Writes a whole claim plan for one article in one round trip. Called before
 * the draft's own model call — see `packages/jobs/src/generation`'s pipeline
 * and its call-order test, which is what makes "the plan is written before
 * the draft" more than a comment.
 */
export async function insertArticleClaims(
  db: Db,
  _scope: AccountScope,
  articleId: string,
  claims: readonly ArticleClaimInput[],
  now: Date = new Date(),
): Promise<readonly ArticleClaimRow[]> {
  if (claims.length === 0) return []
  return db
    .insert(articleClaims)
    .values(
      claims.map((claim) => ({
        articleId,
        text: claim.text,
        kind: claim.kind,
        confidence: claim.confidence,
        evidenceJson: claim.evidence as never,
        sections: [...(claim.sections ?? [])],
        createdAt: now,
      })),
    )
    .returning()
}

export async function findArticleClaims(
  db: Db,
  _scope: AccountScope,
  articleId: string,
): Promise<readonly ArticleClaimRow[]> {
  return db.select().from(articleClaims).where(eq(articleClaims.articleId, articleId))
}
