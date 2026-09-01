import { accountScope, type AccountScope } from '@sortiva/db'

/**
 * tech §3 — "Every authenticated route resolves `account_id` from session —
 * never from the request body", and "every query is `WHERE account_id =
 * session.account_id`, enforced by a repository layer that requires the account
 * scope parameter".
 *
 * This is the seam between those two sentences, and the only place the
 * conversion exists. A handler wrapped in `withAccount` is handed an
 * `AccountScope` — the branded value `packages/db`'s repositories demand, which
 * only `accountScope()` can mint — so a route physically cannot query on an id
 * it read from a body or a query string.
 *
 * Not Next.js `middleware.ts`: that runs before the route on a runtime with no
 * database access, so it could gate a request but not produce the scope, and
 * every handler would still have to rebuild it. See DECISIONS 2026-08-31 T1.1.
 */

/** Reads the signed-in account id, or null. Injectable so tests can drive the wrapper. */
export type SessionReader = () => Promise<string | null>

export const UNAUTHENTICATED_CODE = 'unauthenticated'

export interface AccountContext<Ctx = unknown> {
  readonly scope: AccountScope
  /** Next's own route context (`params`, …), passed through untouched. */
  readonly route: Ctx
}

export type AccountHandler<Ctx = unknown> = (
  request: Request,
  context: AccountContext<Ctx>,
) => Response | Promise<Response>

/** Auth.js is imported lazily so a test driving the wrapper does not boot it. */
const sessionFromAuthJs: SessionReader = async () => {
  const { auth } = await import('./auth')
  const session = await auth()
  const id = session?.user?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

export function withAccount<Ctx = unknown>(
  handler: AccountHandler<Ctx>,
  readSession: SessionReader = sessionFromAuthJs,
): (request: Request, context: Ctx) => Promise<Response> {
  return async (request, context) => {
    const accountId = await readSession()
    if (!accountId) return unauthenticated()
    return handler(request, { scope: accountScope(accountId), route: context })
  }
}

/**
 * The error envelope every route shares (`errorResponseSchema` in
 * `packages/core`): `code` is the contract, `message` is for humans.
 */
function unauthenticated(): Response {
  return Response.json(
    { error: { code: UNAUTHENTICATED_CODE, message: 'Sign in to continue.' } },
    { status: 401 },
  )
}
