import type { LoaderFunctionArgs } from 'react-router'
import { banners } from '../../core/status.ts'
import { db, requireStore } from '../server/context.server.ts'

export async function loader({ request }: LoaderFunctionArgs) {
  return Response.json(await banners(db(), requireStore(request)))
}
