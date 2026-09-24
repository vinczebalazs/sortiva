/**
 * Reading a merchant's store and writing to it are two separate permissions,
 * asked for at two separate moments. This is the first one, and it contains
 * nothing that can change anything in their store.
 *
 * Permission to publish (`write_content`) is granted later, from Settings or at
 * the first publish attempt, and never here — fear of waking up to unwanted
 * posts is the main reason a merchant hesitates at this screen, so the install
 * must be provably harmless.
 */
export const SHOPIFY_READ_SCOPES = ['read_products', 'read_orders', 'read_content'] as const

/**
 * Permission to post articles. Named here rather than only where publishing
 * lives, because the install has to be able to recognise it: a store that
 * granted it before and is reconnecting is handed it back by Shopify whether we
 * ask or not.
 */
export const SHOPIFY_PUBLISH_SCOPE = 'write_content'

export type ShopifyReadScope = (typeof SHOPIFY_READ_SCOPES)[number]

/** The scope string Shopify's authorize URL expects. */
export const SHOPIFY_READ_SCOPE_PARAM = SHOPIFY_READ_SCOPES.join(',')

export class WriteScopeGranted extends Error {
  override readonly name = 'WriteScopeGranted'
  constructor(readonly scopes: readonly string[]) {
    super(
      `Shopify granted a write scope at install: ${scopes.join(', ')}. ` +
        `Install asks for read scopes only; refusing to store this token.`,
    )
  }
}

/**
 * Refuses a grant that carries write permission the merchant never gave.
 *
 * This is not defensive noise. The app's configured permissions live in
 * Shopify's dashboard, outside this repository, and a merchant installing an
 * app that once had write permissions can be handed them again without anyone
 * here changing a line. Storing that token silently would make "read-only" —
 * which we say on the connect screen in those words — untrue.
 *
 * The exception, and it is the merchant's own doing: a store that already went
 * through the publishing screen and said yes. When such a store reconnects,
 * Shopify hands back everything it has ever granted, publishing included, and
 * refusing that token would lock out precisely the merchants who trusted us
 * most — they could never reconnect at all. Permission to publish is the only
 * thing that may come back this way; anything else is still refused.
 */
export function assertReadOnlyGrant(
  granted: readonly string[],
  options: { publishGrantedBefore?: boolean } = {},
): void {
  const write = granted.filter((scope) => scope.startsWith('write_'))
  if (write.length === 0) return
  if (options.publishGrantedBefore && write.every((scope) => scope === SHOPIFY_PUBLISH_SCOPE)) return
  throw new WriteScopeGranted(write)
}

/** True when this connection may publish. False for every connection this card creates. */
export function canPublish(granted: readonly string[]): boolean {
  return granted.includes('write_content')
}
