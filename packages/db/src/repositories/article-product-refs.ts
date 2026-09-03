import { eq } from 'drizzle-orm'
import type { Db } from '../client'
import { articleProductRefs } from '../schema'
import type { AccountScope } from '../scope'

export type ArticleProductRefRow = typeof articleProductRefs.$inferSelect

/**
 * Where a volatile value (price, stock, sale status, URL) sits in an article
 * body — never as literal text (founder decision, 2026-09-01, `DECISIONS.md`
 * `T4.0`). One row per product-mention token (`{{p1}}`) the writer declared;
 * `resolvedValuesJson` stays empty until publish/republish resolves it
 * against the live store (`T5.1`/`T5.2`), which is outside this card's scope.
 */
export interface ArticleProductRefInput {
  readonly productId: string | null
  readonly familyId: string | null
  readonly refType: ArticleProductRefRow['refType']
  /** The `{{id}}` token the draft carries — how the resolver finds this row. */
  readonly placeholderKey: string
  readonly fieldsRendered: readonly ArticleProductRefRow['fieldsRendered'][number][]
}

export async function insertArticleProductRefs(
  db: Db,
  _scope: AccountScope,
  articleId: string,
  refs: readonly ArticleProductRefInput[],
  now: Date = new Date(),
): Promise<readonly ArticleProductRefRow[]> {
  if (refs.length === 0) return []
  return db
    .insert(articleProductRefs)
    .values(
      refs.map((ref) => ({
        articleId,
        productId: ref.productId,
        familyId: ref.familyId,
        refType: ref.refType,
        placeholderKey: ref.placeholderKey,
        fieldsRendered: [...ref.fieldsRendered],
        createdAt: now,
      })),
    )
    .returning()
}

export async function findArticleProductRefs(
  db: Db,
  _scope: AccountScope,
  articleId: string,
): Promise<readonly ArticleProductRefRow[]> {
  return db.select().from(articleProductRefs).where(eq(articleProductRefs.articleId, articleId))
}
