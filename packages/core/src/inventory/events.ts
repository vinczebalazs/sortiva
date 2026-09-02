import type { CatalogEvent } from '../contracts/opportunities'
import type { StoreContentKind } from './ports'

/**
 * Turning "the store changed something" into "re-read exactly this".
 *
 * The alternative — re-walking the whole store on every webhook — is both slow
 * and expensive, and a busy store fires these all day.
 */

/** One thing to go and re-read. */
export interface InventoryTarget {
  readonly kind: StoreContentKind
  readonly shopifyId: string
}

export interface CatalogEventFanout {
  /** Things to re-read, newest change first, each named once. */
  readonly resync: readonly InventoryTarget[]
  /**
   * Things the store says are gone. Reported rather than acted on: what should
   * happen to the inventory row of a page that no longer exists is not settled —
   * see DECISIONS 2026-09-02 T3.2.
   */
  readonly removed: readonly InventoryTarget[]
}

/**
 * Which changes can move a page's words, and which cannot.
 *
 * A price change and a stock change do not alter a page's title, its search
 * fields, its headings or its links, so the checksum would come back identical
 * and the re-read would have bought nothing. They are the two most frequent
 * events a store emits, so ignoring them here is most of the saving.
 */
export function catalogEventsToTargets(events: readonly CatalogEvent[]): CatalogEventFanout {
  const resync = new Map<string, { target: InventoryTarget; at: string }>()
  const removed = new Map<string, InventoryTarget>()

  for (const event of events) {
    if (event.kind === 'product_deleted') {
      removed.set(`product:${event.entityId}`, { kind: 'product', shopifyId: event.entityId })
      continue
    }
    const kind = resyncKindFor(event.kind)
    if (!kind) continue
    const key = `${kind}:${event.entityId}`
    const existing = resync.get(key)
    // Deliveries arrive out of order as a matter of course, so the event that
    // wins is the latest one that happened, not the last one to arrive.
    if (!existing || existing.at < event.occurredAt) {
      resync.set(key, { target: { kind, shopifyId: event.entityId }, at: event.occurredAt })
    }
  }

  for (const key of removed.keys()) resync.delete(key)

  return {
    resync: [...resync.values()]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .map((entry) => entry.target),
    removed: [...removed.values()],
  }
}

function resyncKindFor(kind: CatalogEvent['kind']): StoreContentKind | undefined {
  switch (kind) {
    case 'product_created':
    case 'product_updated':
      return 'product'
    case 'collection_updated':
      return 'collection'
    default:
      return undefined
  }
}
