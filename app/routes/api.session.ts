import type { ActionFunctionArgs } from 'react-router'
import { installShopifyStore } from '../../connectors/shopify/install.ts'
import { verifySessionToken } from '../../connectors/shopify/session-token.ts'
import { startInitialLearn } from '../../jobs/catalog.ts'
import { db, shopifyApp, signAppToken } from '../server/context.server.ts'

/** The Shopify shell trades App Bridge's session token for our own; the first one for a shop installs it. */
export async function action({ request }: ActionFunctionArgs) {
  const { sessionToken } = (await request.json()) as { sessionToken?: string }
  const app = shopifyApp()
  const claims = sessionToken ? verifySessionToken(sessionToken, app.clientId, app.clientSecret) : null
  if (!claims) return Response.json({ error: 'invalid session token' }, { status: 401 })

  const { rows } = await db().query<{ id: number; ready: boolean }>(
    `select id, (closed_at is null and refresh_token_enc is not null) as ready from stores where shop_domain = $1`,
    [claims.shopDomain],
  )
  let storeId = rows[0]?.ready ? rows[0].id : null
  if (storeId === null) {
    storeId = await installShopifyStore(db(), app, claims.shopDomain, sessionToken!)
    await startInitialLearn(db(), storeId)
  }
  return Response.json({ token: signAppToken(storeId), storeId })
}
