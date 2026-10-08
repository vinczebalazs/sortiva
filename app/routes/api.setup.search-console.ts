import type { ActionFunctionArgs } from 'react-router'
import { skipSearchConsole } from '../../core/settings.ts'
import { setupState } from '../../core/setup.ts'
import { db, requireStore } from '../server/context.server.ts'

// Only "Skip for now" exists until the Search Console connection is built.
export async function action({ request }: ActionFunctionArgs) {
  const storeId = requireStore(request)
  await skipSearchConsole(db(), storeId)
  return Response.json(await setupState(db(), storeId))
}
