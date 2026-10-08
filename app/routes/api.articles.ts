import type { LoaderFunctionArgs } from 'react-router'
import { articlesState, type ArticleStatus } from '../../core/articles.ts'
import { db, requireStore } from '../server/context.server.ts'

const STATUSES: ArticleStatus[] = ['held', 'awaiting_review', 'ready', 'exported', 'published', 'draft_in_shopify', 'removed_by_merchant']

export async function loader({ request }: LoaderFunctionArgs) {
  const status = new URL(request.url).searchParams.get('status') as ArticleStatus | null
  return Response.json(await articlesState(db(), requireStore(request), status && STATUSES.includes(status) ? status : undefined))
}
