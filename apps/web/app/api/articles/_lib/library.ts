import { listArticlesQuerySchema } from '@sortiva/core'
import type { Db } from '@sortiva/db'
// Deep import, not the `@sortiva/jobs` barrel — see the identical note in
// `review.ts`, which hit the build failure this avoids.
import { listArticles, type ArticleLibraryFilter } from '@sortiva/jobs/generation/article-library'
import type { AccountHandler } from '../../auth/_lib/session'

/**
 * `GET /api/articles` — everything this store has had written.
 *
 * Parse → call `packages/jobs/src/generation` → serialise. The filters are
 * declared in the contract, so they are honoured here even though today's
 * screen narrows the rows it was given in the browser instead of asking.
 *
 * The whole catalogue comes back in one answer and the cursor is always null.
 * A store writes at most one article a day, and the screen's own filters run
 * over whatever it was handed — so a page limit would quietly hide the rows a
 * filter exists to surface, which is the same shape of failure as a screen with
 * no server behind it. If a back catalogue ever grows large enough to matter,
 * the fix is server-side filtering, not a silent cap.
 */

export interface LibraryDeps {
  readonly db: Db
}

/**
 * A query string carries text; the contract's filter is typed. Anything that is
 * not a filter we recognise is dropped rather than guessed at, and a filter we
 * cannot read is a bad request rather than a silently unfiltered list — a list
 * that ignores the filter looks exactly like a store with nothing to hide.
 */
function filterFrom(url: URL): ArticleLibraryFilter | 'invalid' {
  const states = url.searchParams.getAll('state')
  const flag = (name: string): boolean | undefined => {
    const raw = url.searchParams.get(name)
    return raw === null ? undefined : raw === 'true'
  }
  const parsed = listArticlesQuerySchema.safeParse({
    ...(states.length > 0 ? { state: states } : {}),
    ...(flag('hasPerformance') === undefined ? {} : { hasPerformance: flag('hasPerformance') }),
    ...(flag('needsAttention') === undefined ? {} : { needsAttention: flag('needsAttention') }),
    ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor') as string } : {}),
  })
  if (!parsed.success) return 'invalid'
  return {
    ...(parsed.data.state ? { states: parsed.data.state } : {}),
    ...(parsed.data.hasPerformance === undefined ? {} : { hasPerformance: parsed.data.hasPerformance }),
    ...(parsed.data.needsAttention === undefined ? {} : { needsAttention: parsed.data.needsAttention }),
  }
}

export function makeListArticlesHandler(deps: LibraryDeps): AccountHandler {
  return async (request, { scope }) => {
    const filter = filterFrom(new URL(request.url))
    if (filter === 'invalid') {
      return Response.json(
        { error: { code: 'invalid_query', message: 'That filter is not one we recognise.' } },
        { status: 422 },
      )
    }

    const articles = await listArticles({ db: deps.db }, { accountId: scope.accountId, filter })
    return Response.json({ articles, cursor: null })
  }
}
