import type { Db } from '@sortiva/db'
import type { AccountHandler } from '../../auth/_lib/session'
import { loadAccountView } from './load'

/**
 * main §4.3 — the dashboard shell's one read. Kept out of `route.ts` so the
 * integration test can drive the identical function through the identical
 * `withAccount` wrapper, against its own isolated database and a session it
 * controls.
 */
export function makeAccountRouteHandler(database?: Db): AccountHandler {
  return async (_request, { scope }) => {
    const view = await loadAccountView(scope, database)
    if (!view) {
      return Response.json(
        { error: { code: 'account_not_found', message: 'This account no longer exists.' } },
        { status: 404 },
      )
    }
    return Response.json(view)
  }
}

export const accountRouteHandler = makeAccountRouteHandler()
