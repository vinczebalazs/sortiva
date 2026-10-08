import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router'
import { confirmProfile, setupState, type ProfileInput } from '../../core/setup.ts'
import { db, requireStore } from '../server/context.server.ts'

export async function loader({ request }: LoaderFunctionArgs) {
  return Response.json(await setupState(db(), requireStore(request)))
}

export async function action({ request }: ActionFunctionArgs) {
  const storeId = requireStore(request)
  const result = await confirmProfile(db(), storeId, (await request.json()) as ProfileInput)
  if (!result.ok) return Response.json(result, { status: 422 })
  return Response.json(await setupState(db(), storeId))
}
