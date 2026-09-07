import {
  accountScope,
  articleLibraryRows,
  type ArticleLibraryRow,
  type ArticleRow,
  type Db,
} from '@sortiva/db'

/**
 * The articles library: everything this store has had written, newest first.
 *
 * One decision is worth stating out loud, because it is invisible from the
 * response. An article a merchant published over a quality rejection sits in a
 * state of its own that means "a person cleared this to go out" — a state the
 * screens have no word for. It is reported here as a draft, which is what the
 * merchant sees for every other article that is written and waiting for the
 * publishing hour, and the override badge beside it is what says how it got
 * there. Inventing a sixth state name for the browser would put the same fact
 * in two vocabularies.
 */

/** The state vocabulary the screens have. The storage layer has one more value than this. */
export type LibraryArticleState = 'draft' | 'in_review' | 'published' | 'rejected' | 'discarded'

export interface LibraryArticle {
  readonly id: string
  readonly title: string
  readonly state: LibraryArticleState
  readonly delivery: 'export' | 'auto'
  readonly publishedAt: string | null
  readonly publishedUrl: string | null
  readonly publishedViaOverride: boolean
  readonly repaired: boolean
  readonly refreshedCount: number
  readonly performance: null
}

export interface ArticleLibraryDeps {
  readonly db: Db
}

export interface ArticleLibraryFilter {
  readonly states?: readonly LibraryArticleState[]
  readonly hasPerformance?: boolean
  readonly needsAttention?: boolean
}

export function libraryStateOf(state: ArticleRow['state']): LibraryArticleState {
  return state === 'cleared_to_deliver' ? 'draft' : state
}

/**
 * Waiting on the merchant rather than on us: a draft nobody has read, one held
 * back that they may still choose to publish, and an exported one whose
 * published address we were never told — the last being the only one of the
 * three they may not know is outstanding. The same rule the screen applies to
 * the rows it is given, so asking the server for it cannot disagree with
 * filtering in the browser.
 */
function needsAttention(article: LibraryArticle): boolean {
  if (article.state === 'in_review' || article.state === 'rejected') return true
  return article.state === 'published' && article.delivery === 'export' && article.publishedUrl === null
}

export function summariseArticle(row: ArticleLibraryRow): LibraryArticle {
  const { article } = row
  return {
    id: article.id,
    title: article.title,
    state: libraryStateOf(article.state),
    delivery: article.delivery,
    publishedAt: article.publishedAt?.toISOString() ?? null,
    publishedUrl: article.publishedUrl,
    publishedViaOverride: article.publishedViaOverride,
    repaired: row.repaired,
    refreshedCount: row.refreshCount,
    // Nothing computes a per-article performance window: the table that would
    // hold one is created and written by nobody, because the learning loop that
    // fills it is deferred. Null is the honest answer and the screen already
    // reads it as "too new to judge" rather than as a failure.
    performance: null,
  }
}

export async function listArticles(
  deps: ArticleLibraryDeps,
  input: { readonly accountId: string; readonly filter?: ArticleLibraryFilter },
): Promise<readonly LibraryArticle[]> {
  const rows = await articleLibraryRows(deps.db, accountScope(input.accountId))
  const filter = input.filter ?? {}
  return rows.map(summariseArticle).filter((article) => {
    if (filter.states && filter.states.length > 0 && !filter.states.includes(article.state)) return false
    if (filter.hasPerformance && article.performance === null) return false
    if (filter.needsAttention && !needsAttention(article)) return false
    return true
  })
}
