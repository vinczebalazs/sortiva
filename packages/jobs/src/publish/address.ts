import { accountScope, findDomainForAccount, type Db } from '@sortiva/db'

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
 * The domain the merchant claimed at signup is that host, and it is per
 * account, while the client that posts to Shopify is one per process. So it is
 * read here, beside the publish that needs it, and handed to the client with
 * the rest of the call.
 *
 * The fallback is for a case that should not be reachable — an account holds a
 * claimed domain before it can hold a Shopify connection — and keeps the old
 * behaviour rather than inventing a new way for a publish to be refused.
 */
export async function storefrontDomainFor(
  db: Db,
  accountId: string,
  shopHandle: string,
): Promise<string> {
  const domain = await findDomainForAccount(db, accountScope(accountId))
  return domain?.domainNormalized ?? `${shopHandle}.myshopify.com`
}
