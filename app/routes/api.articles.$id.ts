import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router'
import { approveArticle, articleDetail, discardArticle, setPublishedUrl } from '../../core/articles.ts'
import { db, requireStore } from '../server/context.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
  const detail = await articleDetail(db(), requireStore(request), Number(params.id))
  return detail ? Response.json(detail) : Response.json({ error: 'not found' }, { status: 404 })
}

export async function action({ request, params }: ActionFunctionArgs) {
  const storeId = requireStore(request)
  const id = Number(params.id)
  const body = (await request.json()) as { action: 'approve' | 'discard' | 'published_url'; url?: string }
  if (body.action === 'approve') return answer(await approveArticle(db(), storeId, id))
  if (body.action === 'discard') return answer(await discardArticle(db(), storeId, id))
  if (body.action === 'published_url') {
    const result = await setPublishedUrl(db(), storeId, id, String(body.url ?? ''))
    return Response.json({ result }, { status: result === 'ok' ? 200 : result === 'invalid' ? 422 : 409 })
  }
  return Response.json({ error: 'unknown action' }, { status: 400 })
}

function answer(ok: boolean) {
  return ok ? Response.json({ ok: true }) : Response.json({ error: 'not in a state that allows this' }, { status: 409 })
}
