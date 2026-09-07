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
  /** Overridable so a test can walk a store at a time it chooses. */
  readonly now?: () => Date
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
  /**
   * Pages marked gone, present only on the batch that finished a walk. Absent
   * and zero say different things: absent means we have not finished looking.
   */
  readonly markedGone?: number
}

/**
 * When the walk in progress started, carried in the cursor the queue hands back.
 *
 * It has to survive being handed to the queue and read again, because a store is
 * walked across many separate job runs and nothing else on this side lives that
 * long. The source ignores cursor keys it does not know and builds a fresh
 * cursor for each following batch, so this is re-attached every time rather than
 * expected to come back on its own.
 */
const WALK_STARTED_AT = 'walkStartedAt'

function walkStartOf(cursor: InventoryCursor | undefined, fallback: Date): Date {
  const carried = cursor?.[WALK_STARTED_AT]
  if (carried === undefined) return fallback
  const parsed = new Date(carried)
  return Number.isNaN(parsed.getTime()) ? fallback : parsed
}

export async function syncInventoryBatch(
  deps: InventorySyncDeps,
  accountId: string,
  cursor: InventoryCursor | undefined,
  limit: number,
): Promise<InventorySyncResult> {
  const now = (deps.now ?? (() => new Date()))()
  const walkStartedAt = walkStartOf(cursor, now)
  const origin = await deps.source.storefrontOrigin(accountId)
  const batch = await deps.source.next(accountId, cursor, limit)
  const rows = await toRows(deps, accountId, batch.records, origin)
  // Ahead of the write, so a batch that dies partway has still recorded what it
  // saw. The two mistakes are not equal: recording a page as seen when it was
  // not delays noticing a deletion by a day, while missing one marks a page the
  // merchant still serves as deleted.
  if (rows.length > 0) {
    await deps.writer.markSeen(
      accountId,
      rows.map((row) => row.url),
      now,
    )
  }
  const changed = await writeChanged(deps, accountId, rows)

  if (batch.next) {
    return {
      seen: batch.records.length,
      changed: changed.length,
      changedUrls: changed.map((row) => row.url),
      next: { ...batch.next, [WALK_STARTED_AT]: walkStartedAt.toISOString() },
    }
  }

  // Reaching the end of the store is the only thing that makes an absence mean
  // anything, so this is the one place a page may be marked gone.
  const markedGone = await deps.writer.markGoneNotSeenSince(accountId, walkStartedAt)
  return {
    seen: batch.records.length,
    changed: changed.length,
    changedUrls: changed.map((row) => row.url),
    markedGone,
  }
}

/**
 * Re-reads a named set of things after the store said they changed.
 *
 * The same mapping and the same checksum diff as a sweep batch: a webhook is a
 * reason to look now rather than a different way of looking.
 *
 * It records what it saw, and never concludes anything is missing. Reading a
 * handful of named pages says nothing whatever about the ones nobody asked
 * about, so only the walk that reaches the end of the store may mark a page
 * gone.
 */
export async function syncInventoryRecords(
  deps: InventorySyncDeps,
  accountId: string,
  records: readonly StoreContentRecord[],
): Promise<InventorySyncResult> {
  const origin = await deps.source.storefrontOrigin(accountId)
  const rows = await toRows(deps, accountId, records, origin)
  if (rows.length > 0) {
    await deps.writer.markSeen(
      accountId,
      rows.map((row) => row.url),
      (deps.now ?? (() => new Date()))(),
    )
  }
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
