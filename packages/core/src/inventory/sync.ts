import { toStorePageRow } from './pages'
import type {
  FamilyLookup,
  InventoryCursor,
  InventoryTarget,
  StoreContentRecord,
  StoreContentSource,
  StorePageRow,
  StorePageWriter,
} from './ports'

/**
 * Walking a store's published things into the inventory.
 *
 * One batch per call, resumable by cursor, because the storefront answers about
 * one request a second and a large store is a twenty-minute walk. The job that
 * drives this hands the cursor back to the queue when it runs out of budget, so
 * a killed run resumes where it stopped rather than starting the store again.
 *
 * Nothing here reaches out to a page. Every fact comes from what the store
 * already told us about itself.
 */

export interface InventorySyncDeps {
  readonly source: StoreContentSource
  readonly writer: StorePageWriter
  readonly families: FamilyLookup
}

export interface InventorySyncResult {
  /** Things read from the store this batch. */
  readonly seen: number
  /** Rows whose content actually moved, and so were written. */
  readonly changed: number
  /** The addresses of those rows — what a caller re-scores or re-analyses. */
  readonly changedUrls: readonly string[]
  /** Absent once the whole store has been walked. */
  readonly next?: InventoryCursor
}

export async function syncInventoryBatch(
  deps: InventorySyncDeps,
  accountId: string,
  cursor: InventoryCursor | undefined,
  limit: number,
): Promise<InventorySyncResult> {
  const origin = await deps.source.storefrontOrigin(accountId)
  const batch = await deps.source.next(accountId, cursor, limit)
  const rows = await toRows(deps, accountId, batch.records, origin)
  const changed = await writeChanged(deps, accountId, rows)
  return {
    seen: batch.records.length,
    changed: changed.length,
    changedUrls: changed.map((row) => row.url),
    ...(batch.next ? { next: batch.next } : {}),
  }
}

/**
 * Re-reads a named set of things after the store said they changed.
 *
 * The same mapping and the same checksum diff as a sweep batch: a webhook is a
 * reason to look now rather than a different way of looking.
 */
export async function syncInventoryRecords(
  deps: InventorySyncDeps,
  accountId: string,
  records: readonly StoreContentRecord[],
): Promise<InventorySyncResult> {
  const origin = await deps.source.storefrontOrigin(accountId)
  const rows = await toRows(deps, accountId, records, origin)
  const changed = await writeChanged(deps, accountId, rows)
  return {
    seen: records.length,
    changed: changed.length,
    changedUrls: changed.map((row) => row.url),
  }
}

/**
 * Re-reads the things the store said changed, and writes back whatever moved.
 *
 * A webhook is a reason to look now, not a different way of looking: the same
 * mapping and the same checksum diff as a sweep batch.
 */
export async function resyncInventoryTargets(
  deps: InventorySyncDeps,
  accountId: string,
  targets: readonly InventoryTarget[],
): Promise<InventorySyncResult> {
  if (targets.length === 0) return { seen: 0, changed: 0, changedUrls: [] }
  const records = await deps.source.read(accountId, targets)
  return syncInventoryRecords(deps, accountId, records)
}

async function toRows(
  deps: InventorySyncDeps,
  accountId: string,
  records: readonly StoreContentRecord[],
  origin: string,
): Promise<StorePageRow[]> {
  const familyIds = await familyIdsByRecord(deps.families, accountId, records)
  return records.map((record, index) =>
    toStorePageRow({
      record,
      storefrontOrigin: origin,
      familyIds: familyIds[index] ?? [],
    }),
  )
}

/**
 * Which families each row belongs to.
 *
 * A collection's families are the families of the products in it; a product's
 * is its own. Pages and blog posts get none here: mapping a written page to a
 * family is the same topic mapping our own articles use, and that does not
 * exist yet — see DECISIONS 2026-09-02 T3.2.
 *
 * One lookup for the whole batch rather than one per row: a batch of collections
 * can name the same product many times, and asking about each separately is the
 * same query run a hundred times.
 */
async function familyIdsByRecord(
  families: FamilyLookup,
  accountId: string,
  records: readonly StoreContentRecord[],
): Promise<string[][]> {
  const productIds = new Set<string>()
  for (const record of records) {
    if (record.kind === 'product') productIds.add(record.shopifyId)
    for (const id of record.memberProductIds ?? []) productIds.add(id)
  }
  if (productIds.size === 0) return records.map(() => [])

  const byProduct = await families.familiesForProducts(accountId, [...productIds])
  return records.map((record) => {
    const ids = new Set<string>()
    if (record.kind === 'product') {
      const own = byProduct.get(record.shopifyId)
      if (own) ids.add(own)
    }
    for (const memberId of record.memberProductIds ?? []) {
      const family = byProduct.get(memberId)
      if (family) ids.add(family)
    }
    return [...ids]
  })
}

/**
 * Writes only what moved.
 *
 * A store's pages mostly do not change from one night to the next, and writing
 * an unchanged row would restamp its `last_synced_at`, look like an edit to
 * everything watching the checksum, and re-run the paid analyses that hang off
 * one.
 */
async function writeChanged(
  deps: InventorySyncDeps,
  accountId: string,
  rows: readonly StorePageRow[],
): Promise<StorePageRow[]> {
  if (rows.length === 0) return []
  const known = await deps.writer.knownChecksums(
    accountId,
    rows.map((row) => row.url),
  )
  const changed = rows.filter((row) => known.get(row.url) !== row.checksum)
  if (changed.length > 0) await deps.writer.upsert(accountId, changed)
  return changed
}
