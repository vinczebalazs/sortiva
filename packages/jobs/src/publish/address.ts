import { accountScope, findDomainForAccount, findShopifyConnForAccount, type Db } from '@sortiva/db'

/**
 * The host a published article's address is recorded under.
 *
 * Not the `myshopify.com` handle. That host is how we reach the Admin API; it
 * is not where the store's shoppers are, and Search Console reports a store's
 * traffic under the domain shoppers actually visit. An article filed under the
 * `myshopify` host can therefore never be matched to the clicks it earns — a
 * working, ranking article would look like it had earned nothing, for ever,
 * and nobody would notice for months.
 *
 * And not the domain the merchant claimed at signup either, which is the same
 * trap one step further in. That one is stored normalised: `www.` removed and
 * cut back to the registrable domain. A store serving on `www.shop.com` or on
 * `store.brand.com` therefore has a claimed domain that is a *different string*
 * from the host its pages are actually served under, and every article of
 * theirs would be filed under an address Search Console never reports.
 *
 * So the store's own answer wins: the host Shopify says the storefront serves
 * on, recorded when the connection was made. The claimed domain is the fallback
 * for a connection made before that was stored, and the shop handle the
 * fallback of last resort — neither is a new way for a publish to be refused.
 */
export async function storefrontDomainFor(
  db: Db,
  accountId: string,
  shopHandle: string,
): Promise<string> {
  const scope = accountScope(accountId)
  const connection = await findShopifyConnForAccount(db, scope)
  if (connection?.storefrontHost) return connection.storefrontHost
  const domain = await findDomainForAccount(db, scope)
  return domain?.domainNormalized ?? `${shopHandle}.myshopify.com`
}
