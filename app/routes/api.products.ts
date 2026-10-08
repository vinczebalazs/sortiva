import type { LoaderFunctionArgs } from 'react-router'
import { productsState } from '../../core/screens.ts'
import { syncQueued } from '../../jobs/catalog.ts'
import { db, requireStore } from '../server/context.server.ts'

export async function loader({ request }: LoaderFunctionArgs) {
  const storeId = requireStore(request)
  const state = await productsState(db(), storeId)
  // A sync that is queued but not yet started still counts as running, so the button stays disabled.
  if (!state.sync.running && (await syncQueued(db(), storeId))) state.sync.running = true
  return Response.json(state)
}
