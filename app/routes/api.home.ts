import type { LoaderFunctionArgs } from 'react-router'
import { homeState } from '../../core/screens.ts'
import { db, requireStore } from '../server/context.server.ts'

export async function loader({ request }: LoaderFunctionArgs) {
  return Response.json(await homeState(db(), requireStore(request)))
}
