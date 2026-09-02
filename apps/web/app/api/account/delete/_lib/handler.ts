import {
  deleteAccountRequestSchema,
  requestAccountDeletion,
  type AccountLifecycleStore,
  type PosthogCapture,
} from '@sortiva/core'
import { makeAccountLifecycleStore, type Db } from '@sortiva/db'
// A deep import, not the package barrel: the barrel re-exports the spend-cap
// sweep, which pulls the threshold config's file loader into a bundle with no
// filesystem. The domain claim, the Shopify webhook receiver and the Search
// Console routes take the same shape.
import { enqueueAccountClose } from '@sortiva/jobs/sweeps/queue'
import type { AccountHandler } from '../../../auth/_lib/session'

/**
 * A merchant asking to be deleted.
 *
 * What happens while they wait is entirely local: the deletion is stamped, the
 * domain gets a release deadline a week out, both connections are marked dead,
 * and the preview row goes. Then a job is queued to tell Stripe, Shopify and
 * Google — which is where those calls have to be, because a Stripe call may
 * never sit in a request path.
 *
 * The confirmation word is checked here rather than trusted from the interface:
 * this route is reachable without one.
 */
export interface DeleteAccountHandlerOptions {
  database?: Db
  store?: AccountLifecycleStore
  capture?: Pick<PosthogCapture, 'capture'>
  /** Overridden in tests that assert on what was queued without a worker present. */
  enqueue?: (database: Db, accountId: string) => Promise<void>
}

export function makeDeleteAccountHandler(
  options: DeleteAccountHandlerOptions = {},
): AccountHandler {
  const enqueue =
    options.enqueue ?? ((database: Db, accountId: string) => enqueueAccountClose(database, { accountId }))

  return async (request, { scope }) => {
    const body = await readJson(request)
    const parsed = deleteAccountRequestSchema.safeParse(body)
    if (!parsed.success) {
      return problem(
        400,
        'confirmation_required',
        'Type DELETE to confirm. This cannot be undone.',
      )
    }

    const store =
      options.store ??
      makeAccountLifecycleStore({
        ...(options.database ? { database: options.database } : {}),
        enqueueClosure: enqueue,
      })
    const result = await requestAccountDeletion(
      options.capture ? { store, capture: options.capture } : { store },
      { accountId: scope.accountId },
    )

    if (result.kind === 'not_found') {
      return problem(404, 'account_not_found', 'This account no longer exists.')
    }
    if (result.kind === 'already_deleted') {
      // Not an error. The merchant asked for something that has already
      // happened, and telling them it failed would be false.
      return Response.json({ ok: true })
    }

    return Response.json({ ok: true })
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

function problem(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}

export const deleteAccountHandler = makeDeleteAccountHandler()
