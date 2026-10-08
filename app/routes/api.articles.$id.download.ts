import type { LoaderFunctionArgs } from 'react-router'
import { exportBundle } from '../../core/articles.ts'
import { db, requireStore } from '../server/context.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
  const bundle = await exportBundle(db(), requireStore(request), Number(params.id))
  if (!bundle) return Response.json({ error: 'not downloadable' }, { status: 409 })
  return new Response(Buffer.from(bundle.bytes), {
    headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${bundle.filename}"`, 'cache-control': 'no-store' },
  })
}
