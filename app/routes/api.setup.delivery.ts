import type { ActionFunctionArgs } from 'react-router'
import { finishSetup, type DeliveryInput } from '../../core/settings.ts'
import { setupState } from '../../core/setup.ts'
import { requestDiscovery } from '../../jobs/topics.ts'
import { db, requireStore } from '../server/context.server.ts'

export async function action({ request }: ActionFunctionArgs) {
  const storeId = requireStore(request)
  const result = await finishSetup(db(), storeId, (await request.json()) as DeliveryInput)
  if (!result.ok) return Response.json(result, { status: 422 })
  if (result.first) await requestDiscovery(db(), storeId, 'setup', new Date().toISOString())
  return Response.json(await setupState(db(), storeId))
}
