import { EntitlementInactiveError, assertEntitled, type RefreshBlocker } from '@sortiva/core'
import { readLifecycleState, type AccountScope, type Db } from '@sortiva/db'
// Deep import, not the `@sortiva/jobs` barrel — see the identical note in
// `review.ts`, which hit the build failure this avoids.
import { requestArticleRefresh } from '@sortiva/jobs/generation/request-refresh'
import type { AccountHandler } from '../../auth/_lib/session'

/**
 * `POST /api/articles/{articleId}/refresh` — the merchant asks us to rewrite an
 * article we published for them.
 *
 * Parse → call `packages/jobs/src/generation` → serialise. Every rule about
 * whether the rewrite may happen, and everything it becomes, lives there; this
 * only turns the answer into a status code.
 *
 * Pressing it does **not** put a rewrite on the calendar. It puts one piece of
 * work into the pool the calendar draws from, which competes for a day against
 * everything else waiting, under the same cap that stops rewrites crowding out
 * new coverage. Saying otherwise on screen would be a promise this endpoint
 * cannot keep.
 */

export interface RefreshRouteDeps {
  readonly db: Db
  readonly now?: () => Date
}

export type RefreshRouteCtx = { readonly params: Promise<{ articleId: string }> }

function notFound(): Response {
  return Response.json(
    { error: { code: 'article_not_found', message: 'That article is gone.' } },
    { status: 404 },
  )
}

/**
 * The one refusal the merchant is shown as a state of the button rather than
 * an error: they pressed too soon after the last rewrite.
 */
function withinCooldown(): Response {
  return Response.json(
    { error: { code: 'refresh_within_cooldown', message: 'Refreshed recently.' } },
    { status: 409 },
  )
}

/**
 * The other three refusals, each with its own reason.
 *
 * A 422 rather than a 409: nothing about this is a race the merchant lost, and
 * pressing again in a moment will not change the answer. Kept out of the
 * conflict vocabulary for that reason — that enum is exactly the set of codes a
 * lost race returns.
 */
const NOT_ELIGIBLE_MESSAGES: Readonly<Record<Exclude<RefreshBlocker, 'within_cooldown'>, string>> = {
  not_published: 'This article is not published yet, so there is nothing live to rewrite.',
  published_via_override:
    'This article was published over our quality objection, so we do not rewrite it automatically.',
  repair_pending: 'This article is already queued for a correction; that runs first.',
  position_outside_band: 'There is nothing to gain from rewriting this article right now.',
  impressions_below_store_median: 'There is nothing to gain from rewriting this article right now.',
}

function notEligible(blockers: readonly RefreshBlocker[]): Response {
  const first = blockers.find((blocker) => blocker !== 'within_cooldown')
  return Response.json(
    {
      error: {
        code: 'refresh_not_eligible',
        message: first
          ? NOT_ELIGIBLE_MESSAGES[first as Exclude<RefreshBlocker, 'within_cooldown'>]
          : 'This article cannot be refreshed right now.',
      },
    },
    { status: 422 },
  )
}

async function entitlementFailure(db: Db, scope: AccountScope): Promise<Response | undefined> {
  const lifecycle = await readLifecycleState(db, scope)
  try {
    assertEntitled(lifecycle?.subscription ?? null)
    return undefined
  } catch (error) {
    if (error instanceof EntitlementInactiveError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.httpStatus },
      )
    }
    throw error
  }
}

export function makeRequestRefreshHandler(deps: RefreshRouteDeps): AccountHandler<RefreshRouteCtx> {
  return async (_request, { scope, route }) => {
    const { articleId } = await route.params

    // Billing gates making new work, never reading what we already made.
    const denied = await entitlementFailure(deps.db, scope)
    if (denied) return denied

    const result = await requestArticleRefresh(
      { db: deps.db, ...(deps.now ? { now: deps.now } : {}) },
      { accountId: scope.accountId, articleId, source: 'merchant_request' },
    )

    if (result.ok) return Response.json({ ok: true })
    if (result.reason === 'article_not_found') return notFound()
    if (result.blockers.includes('within_cooldown')) return withinCooldown()
    return notEligible(result.blockers)
  }
}
