import {
  accountScope,
  articleRefreshTimes,
  findArticleById,
  findArticleProductRefs,
  findLatestGateDecisionForTopic,
  findTopic,
  liveProductsByIds,
  repairHistory,
  type ArticleRow,
  type Db,
} from '@sortiva/db'
import { ArticleHasNoBody, ArticleNotFound, renderArticleForReading } from '../publish/bundle'
import { BundleNotBuildable } from '@sortiva/core'
import { libraryStateOf, type LibraryArticle } from './article-library'

/**
 * One article, read-only: the words as they would publish, what would be set
 * on the page around them, which products it rests on, the quality report
 * behind it, and what has happened to it.
 *
 * There is no editor and there is no route to one.
 */

export interface ArticleDetailDeps {
  readonly db: Db
}

export interface ArticleQualityReport {
  readonly scores: Readonly<Record<string, number>>
  /** The judge's own sentences. Model-written, always English, and passed through untouched. */
  readonly justifications: Readonly<Record<string, string>>
  readonly promptVersion: string
  readonly modelId: string
  readonly passed: boolean
}

export interface ArticleDetail {
  readonly article: LibraryArticle
  readonly html: string
  readonly metadata: {
    readonly targetKeyword: string
    readonly slug: string
    readonly metaDescription: string
    readonly familyIds: readonly string[]
    readonly opportunityId: string | null
  }
  readonly evidencePack: readonly { readonly productId: string; readonly title: string }[]
  readonly qualityReport: ArticleQualityReport | null
  readonly history: readonly { readonly at: string; readonly event: string }[]
}

/** The judge's numbers, as the gate wrote them onto its own audit row. */
function scoresOf(audit: unknown): Readonly<Record<string, number>> | null {
  if (!audit || typeof audit !== 'object') return null
  const scores = (audit as { scores?: unknown }).scores
  if (!scores || typeof scores !== 'object') return null
  const out: Record<string, number> = {}
  for (const [criterion, value] of Object.entries(scores as Record<string, unknown>)) {
    if (typeof value === 'number') out[criterion] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

function justificationsOf(audit: unknown): Readonly<Record<string, string>> {
  if (!audit || typeof audit !== 'object') return {}
  const written = (audit as { justifications?: unknown }).justifications
  if (!written || typeof written !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [criterion, value] of Object.entries(written as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0) out[criterion] = value
  }
  return out
}

/**
 * The article as it would publish, or nothing.
 *
 * A page that refuses to load is worse than a body we cannot render: the same
 * screen carries the quality report and the "publish anyway" decision, and an
 * article whose product has been deleted from the store is exactly when a
 * merchant needs to see both. So an unbuildable body is an empty one and the
 * rest of the page still arrives.
 */
async function renderedBody(deps: ArticleDetailDeps, accountId: string, articleId: string): Promise<string> {
  try {
    return (await renderArticleForReading({ db: deps.db }, { accountId, articleId })).html
  } catch (error) {
    if (
      error instanceof ArticleHasNoBody ||
      error instanceof ArticleNotFound ||
      error instanceof BundleNotBuildable
    ) {
      return ''
    }
    throw error
  }
}

/**
 * What has happened to this article, oldest first.
 *
 * Assembled from the rows that recorded each thing as it happened rather than
 * from a log, because there is no article event log: the article's own
 * timestamps, the quality gate's audit trail, the rewrite log and the repair
 * outcomes. Approval leaves no mark anywhere, so it is not claimed.
 */
async function historyOf(
  deps: ArticleDetailDeps,
  accountId: string,
  article: ArticleRow,
  decision: Awaited<ReturnType<typeof findLatestGateDecisionForTopic>>,
): Promise<readonly { readonly at: string; readonly event: string }[]> {
  const scope = accountScope(accountId)
  const entries: { at: Date; event: string }[] = [{ at: article.createdAt, event: 'generated' }]

  if (decision) {
    if (decision.outcome === 'overridden') entries.push({ at: decision.decidedAt, event: 'overridden' })
    else if (decision.outcome !== 'passed') entries.push({ at: decision.decidedAt, event: 'rejected' })
  }
  if (article.state === 'discarded') entries.push({ at: article.updatedAt, event: 'discarded' })
  if (article.publishedAt) entries.push({ at: article.publishedAt, event: 'published' })

  for (const at of await articleRefreshTimes(deps.db, scope, article.id)) {
    entries.push({ at, event: 'refreshed' })
  }
  for (const repair of await repairHistory(deps.db, scope, article.id)) {
    entries.push({ at: repair.at, event: 'repaired' })
  }

  return entries
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((entry) => ({ at: entry.at.toISOString(), event: entry.event }))
}

export async function readArticleDetail(
  deps: ArticleDetailDeps,
  input: { readonly accountId: string; readonly articleId: string },
): Promise<ArticleDetail | null> {
  const scope = accountScope(input.accountId)
  const article = await findArticleById(deps.db, scope, input.articleId)
  if (!article) return null

  const topic = await findTopic(deps.db, scope, article.topicId)
  const decision = await findLatestGateDecisionForTopic(deps.db, scope, article.topicId, [3])

  const refs = await findArticleProductRefs(deps.db, scope, input.articleId)
  const productIds = [...new Set(refs.flatMap((ref) => (ref.productId ? [ref.productId] : [])))]
  const products = await liveProductsByIds(deps.db, scope, productIds)

  const repairs = await repairHistory(deps.db, scope, input.articleId)
  const refreshes = await articleRefreshTimes(deps.db, scope, input.articleId)

  const scores = scoresOf(decision?.scoresJson)
  // No prompt and no model means nobody can say which grader produced these
  // sentences, and a model-written justification a merchant cannot see is
  // model-written has no business on the page. Reporting no quality report at
  // all is the honest answer.
  const qualityReport: ArticleQualityReport | null =
    decision && scores && decision.promptVersion && decision.modelId
      ? {
          scores,
          justifications: justificationsOf(decision.scoresJson),
          promptVersion: decision.promptVersion,
          modelId: decision.modelId,
          passed: decision.outcome === 'passed',
        }
      : null

  return {
    article: {
      id: article.id,
      title: article.title,
      state: libraryStateOf(article.state),
      delivery: article.delivery,
      publishedAt: article.publishedAt?.toISOString() ?? null,
      publishedUrl: article.publishedUrl,
      publishedViaOverride: article.publishedViaOverride,
      repaired: repairs.length > 0,
      refreshedCount: refreshes.length,
      performance: null,
    },
    html: await renderedBody(deps, input.accountId, input.articleId),
    metadata: {
      targetKeyword: article.targetKeyword ?? '',
      slug: article.slug,
      metaDescription: article.metaDescription ?? '',
      familyIds: topic?.familyIds ?? [],
      opportunityId: topic?.opportunityId ?? null,
    },
    evidencePack: products.map((product) => ({ productId: product.id, title: product.title })),
    qualityReport,
    history: await historyOf(deps, input.accountId, article, decision),
  }
}
