import {
  EntitlementInactiveError,
  assertEntitled,
  overridePublishRequestSchema,
  type ConflictCode,
} from '@sortiva/core'
import { readLifecycleState, type AccountScope, type Db } from '@sortiva/db'
// Deep import, not the `@sortiva/jobs` barrel — see the identical note in
// `review.ts`, which hit the build failure this avoids.
import { publishAnyway } from '@sortiva/jobs/generation/override-article'
import type { AccountHandler } from '../../auth/_lib/session'

/**
 * `POST /api/articles/{articleId}/publish-anyway` — the merchant overrules a
 * draft our quality bar turned down.
 *
 * Parse → call `packages/jobs/src/generation` → serialise. Whether the override
 * may happen at all, what it writes and what it permanently costs the article
 * live there.
 *
 * The body is required and must name at least one criterion. That is not
 * ceremony: the confirmation dialog exists so the merchant is told what they
 * are overruling, and a request that names nothing is one that did not come
 * from it.
 */

export interface OverrideRouteDeps {
  readonly db: Db
  readonly now?: () => Date
}

export type OverrideRouteCtx = { readonly params: Promise<{ articleId: string }> }

const CONFLICT_MESSAGES: Partial<Record<ConflictCode, string>> = {
  article_not_rejected: 'This draft is not being held back, so there is nothing to overrule.',
  article_already_published: 'This article has already been published.',
}

function conflict(code: ConflictCode): Response {
  return Response.json(
    { error: { code, message: CONFLICT_MESSAGES[code] ?? 'That change could not be made.' } },
    { status: 409 },
  )
}

function notFound(): Response {
  return Response.json(
    { error: { code: 'article_not_found', message: 'That article is gone.' } },
    { status: 404 },
  )
}

async function entitlementFailure(db: Db, scope: AccountScope): Promise<Response | undefined> {
  const lifecycle = await readLifecycleState(db, scope)
  try {
    assertEntitled(lifecycle?.subscription ?? null)
    return undefined
  } catch (error) {
    if (error instanceof EntitlementInactiveError) {
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.httpStatus })
    }
    throw error
  }
}

export function makeOverridePublishHandler(deps: OverrideRouteDeps): AccountHandler<OverrideRouteCtx> {
  return async (request, { scope, route }) => {
    const { articleId } = await route.params

    const parsed = overridePublishRequestSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return Response.json(
        {
          error: {
            code: 'invalid_body',
            message: 'Confirm which quality criteria you are publishing past.',
          },
        },
        { status: 422 },
      )
    }

    // Billing gates publishing, never reading what we already made.
    const denied = await entitlementFailure(deps.db, scope)
    if (denied) return denied

    const result = await publishAnyway(
      { db: deps.db, ...(deps.now ? { now: deps.now } : {}) },
      {
        accountId: scope.accountId,
        articleId,
        acknowledgedCriteria: parsed.data.acknowledgedCriteria,
      },
    )

    if (!result.ok) return result.code === 'not_found' ? notFound() : conflict(result.code)
    return Response.json({ ok: true })
  }
}
