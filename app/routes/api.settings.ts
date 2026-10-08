import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router'
import { saveDelivery, setMerchantPause, settingsState, updateProfile, type DeliveryInput } from '../../core/settings.ts'
import { setupState, type ProfileInput } from '../../core/setup.ts'
import { requestDiscovery } from '../../jobs/topics.ts'
import { db, requireStore } from '../server/context.server.ts'

async function state(storeId: number) {
  return { ...(await settingsState(db(), storeId)), profile: (await setupState(db(), storeId)).profile }
}

export async function loader({ request }: LoaderFunctionArgs) {
  return Response.json(await state(requireStore(request)))
}

type Body = { section: 'profile'; profile: ProfileInput } | { section: 'delivery'; delivery: DeliveryInput } | { section: 'pause'; paused: boolean }

export async function action({ request }: ActionFunctionArgs) {
  const storeId = requireStore(request)
  const body = (await request.json()) as Body
  if (body.section === 'profile') {
    const result = await updateProfile(db(), storeId, body.profile)
    if (!result.ok) return Response.json(result, { status: 422 })
    if (result.changed) await requestDiscovery(db(), storeId, 'profile_changed', new Date().toISOString())
  } else if (body.section === 'delivery') {
    const result = await saveDelivery(db(), storeId, body.delivery)
    if (!result.ok) return Response.json(result, { status: 422 })
  } else if (body.section === 'pause') {
    await setMerchantPause(db(), storeId, Boolean(body.paused))
  } else {
    return Response.json({ error: 'unknown section' }, { status: 400 })
  }
  return Response.json(await state(storeId))
}
