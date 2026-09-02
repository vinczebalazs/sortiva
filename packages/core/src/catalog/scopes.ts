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
export const SHOPIFY_READ_SCOPES = [
  'read_products',
  'read_orders',
  'read_content',
  'read_locales',
] as const

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
 * Refuses a grant that carries any write permission.
 *
 * This is not defensive noise. The app's configured scopes live in the Shopify
 * Partner dashboard, outside this repository, and a merchant re-installing an
 * app that once had write scopes can be handed them again without anyone here
 * changing a line. Storing that token silently would make "read-only" — which
 * we say on the connect screen in those words — untrue.
 */
export function assertReadOnlyGrant(granted: readonly string[]): void {
  const write = granted.filter((scope) => scope.startsWith('write_'))
  if (write.length > 0) throw new WriteScopeGranted(write)
}

/** True when this connection may publish. False for every connection this card creates. */
export function canPublish(granted: readonly string[]): boolean {
  return granted.includes('write_content')
}
