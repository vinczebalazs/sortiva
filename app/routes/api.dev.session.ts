import type { ActionFunctionArgs } from 'react-router'
import { db, signAppToken } from '../server/context.server.ts'

// Signs a local preview or a Playwright run into a seeded store without Shopify. Never on in production.
export async function action({ request }: ActionFunctionArgs) {
  if (process.env.NODE_ENV === 'production' || process.env.DEV_BYPASS !== '1') return new Response(null, { status: 404 })
  const { shopDomain } = (await request.json()) as { shopDomain: string }
  const { rows } = await db().query<{ id: number }>('select id from stores where shop_domain = $1', [shopDomain])
  if (!rows[0]) return Response.json({ error: 'no such store' }, { status: 404 })
  return Response.json({ token: signAppToken(rows[0].id), storeId: rows[0].id })
}
