import { canonicalStoreUrl } from './html'
import { toStorePageRow } from './pages'
import type {
  FamilyLookup,
  InventoryCursor,
  InventoryTarget,
  OurArticleAddressWriter,
  OurArticleLookup,
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
  readonly ourArticles: OurArticleLookup
  readonly articleAddresses: OurArticleAddressWriter
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
  /** Pages in this batch recognised as articles we published. */
  readonly markedOurs: number
  /**
   * Articles of ours the shop has started serving at a new address, whose
   * address we corrected on this batch.
   */
  readonly followedRenames: number
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
  // After the write, because a page seen for the first time has no row to mark
  // until the write has made one. Before the sweep below, because a page we
  // recognise as ours is one the sweep must leave alone.
  const recognised = await recogniseOurArticles(deps, accountId, rows, origin)

  if (batch.next) {
    return {
      seen: batch.records.length,
      changed: changed.length,
      changedUrls: changed.map((row) => row.url),
      ...recognised,
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
    ...recognised,
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
  const recognised = await recogniseOurArticles(deps, accountId, rows, origin)
  return {
    seen: records.length,
    changed: changed.length,
    changedUrls: changed.map((row) => row.url),
    ...recognised,
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
  if (targets.length === 0)
    return { seen: 0, changed: 0, changedUrls: [], markedOurs: 0, followedRenames: 0 }
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

/**
 * Marks the pages in this batch that are articles we published for this store.
 *
 * This is the only thing in the product that ever writes that marking, and two
 * finished behaviours wait on it. An improve-this-page suggestion landing on a
 * page we wrote is refused a list of edits and sent to be rewritten instead —
 * both of which read the marking off the row, so an unmarked article is one the
 * product treats as the merchant's own and hands them busywork about.
 *
 * The match is by address, and both sides are put through the same
 * normalisation before comparing: the walk builds an address out of a handle,
 * while the address on an exported article was typed by a merchant and can
 * carry a trailing slash or a tracking parameter that means nothing.
 *
 * A store whose articles we deliver by export publishes them wherever it
 * likes. Where that is a blog this walk can see, they are recognised here like
 * any other. Where it is not — another site, a platform we have no connection
 * to — the walk never meets them, and they stay unrecognised. That is also why
 * nothing here is allowed to conclude the reverse: a page we do not recognise
 * is never un-marked, because absence from a store is not evidence about an
 * article delivered somewhere else entirely.
 */
async function recogniseOurArticles(
  deps: InventorySyncDeps,
  accountId: string,
  rows: readonly StorePageRow[],
  origin: string,
): Promise<{ markedOurs: number; followedRenames: number }> {
  if (rows.length === 0) return { markedOurs: 0, followedRenames: 0 }
  const published = await deps.ourArticles.publishedArticles(accountId)
  if (published.length === 0) return { markedOurs: 0, followedRenames: 0 }

  const byUrl = new Map<string, string>()
  const heldByArticle = new Map<string, string>()
  for (const article of published) {
    let url: string
    try {
      url = canonicalStoreUrl(article.url, origin)
    } catch {
      // One unreadable address is one article that goes unrecognised. It is
      // never a reason to abandon the walk and leave the whole store unread.
      continue
    }
    // First wins, and the lookup hands them over oldest first: if two articles
    // ever claim one address, the walk settles on the same one every night
    // instead of alternating between them.
    if (!byUrl.has(url)) byUrl.set(url, article.articleId)
    if (!heldByArticle.has(article.articleId)) heldByArticle.set(article.articleId, url)
  }

  // Before the marking below, so a post the merchant has just renamed is
  // recognised at its new address on the same pass rather than a day later.
  const followedRenames = await followRenames(deps, accountId, rows, byUrl, heldByArticle)

  const ours = rows.flatMap((row) => {
    const articleId = byUrl.get(row.url)
    return articleId ? [{ url: row.url, articleId }] : []
  })
  if (ours.length > 0) await deps.writer.markOurs(accountId, ours)
  return { markedOurs: ours.length, followedRenames }
}

/**
 * Notices that a post of ours is being served somewhere else, and writes the
 * new address down.
 *
 * A merchant renaming one of our posts on their shop changes its address and
 * nothing else. Recognition is by address, so without this the product ends up
 * holding two wrong beliefs at once: a page it thinks is our article at an
 * address nobody can open, and a page it thinks is the merchant's own at the
 * address our article is actually at — where an improve-this-page press would
 * hand the merchant a list of edits for words we wrote.
 *
 * The shop's own id for the post is what makes this safe: it is the id we
 * recorded when we made the post, so a match is our own paperwork rather than a
 * guess from a title or a marker, and being wrong here would mean claiming a
 * merchant's own writing as ours.
 *
 * Two deliberate limits. Only a post we made on the shop ourselves has such an
 * id, so nothing here helps a store on export delivery, where the merchant
 * pastes the article onto their own blog and a rename still detaches it. And an
 * article we hold no address for at all is left alone: filling one in is a
 * different question from correcting one, and nobody has asked it.
 */
async function followRenames(
  deps: InventorySyncDeps,
  accountId: string,
  rows: readonly StorePageRow[],
  byUrl: Map<string, string>,
  heldByArticle: Map<string, string>,
): Promise<number> {
  const posts = rows.filter((row) => row.pageType === 'blog_article')
  if (posts.length === 0) return 0
  const onShop = await deps.ourArticles.publishedToShop(accountId)
  if (onShop.length === 0) return 0

  const articleByShopId = new Map<string, string>()
  for (const post of onShop) {
    if (!articleByShopId.has(post.shopifyArticleId)) {
      articleByShopId.set(post.shopifyArticleId, post.articleId)
    }
  }

  let followed = 0
  for (const row of posts) {
    const articleId = articleByShopId.get(row.shopifyId)
    if (articleId === undefined) continue
    const held = heldByArticle.get(articleId)
    if (held === undefined || held === row.url) continue

    await deps.articleAddresses.followRename(accountId, { articleId, from: held, to: row.url })
    // The rest of this batch reads these two, so the marking below lands on the
    // address the shop actually serves.
    if (byUrl.get(held) === articleId) byUrl.delete(held)
    if (!byUrl.has(row.url)) byUrl.set(row.url, articleId)
    heldByArticle.set(articleId, row.url)
    followed += 1
  }
  return followed
}
