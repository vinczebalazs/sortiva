import type { ActionFunctionArgs } from 'react-router'
import { requestSync } from '../../jobs/catalog.ts'
import { db, requireStore } from '../server/context.server.ts'

export async function action({ request }: ActionFunctionArgs) {
  return Response.json({ result: await requestSync(db(), requireStore(request)) })
}
