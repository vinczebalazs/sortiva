import type { CatalogEvent, CatalogEvents } from '@sortiva/core'
import { readCatalogChanges, systemScope, type Db } from '@sortiva/db'

/**
 * The change stream, filled.
 *
 * Until now this seam had a stand-in that replayed two fixture events, and the
 * content inventory and the drift rules were built against it. This is the real
 * one: it answers with what the merchant actually changed, from the same record
 * two producers write to — the webhooks we processed, and the nightly sweep that
 * catches the ones Shopify dropped.
 *
 * The consumer keeps its own place in the stream and hands the cursor back, so
 * nothing here remembers who has read what. Two consumers can therefore be at
 * different points without interfering, and a consumer that loses its place
 * re-reads rather than skips.
 */
export class DatabaseCatalogEvents implements CatalogEvents {
  constructor(private readonly getDb: () => Db) {}

  async since(
    accountId: string,
    cursor?: string,
  ): Promise<{ events: readonly CatalogEvent[]; cursor: string }> {
    const page = await readCatalogChanges(
      this.getDb(),
      systemScope('a consumer reads one store changes from the shared change record'),
      accountId,
      cursor,
    )
    return {
      events: page.changes.map(
        (change): CatalogEvent => ({
          accountId: change.accountId,
          kind: change.kind as CatalogEvent['kind'],
          entityId: change.entityId,
          occurredAt: change.occurredAt,
          changedFields: change.changedFields,
        }),
      ),
      cursor: page.cursor,
    }
  }
}
