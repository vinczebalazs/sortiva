/**
 * What the store already has, as this module sees it.
 *
 * The inventory is assembled from what the store told us through its own admin
 * interface — never by going out and reading its pages. There is no crawler in
 * V1, and `no-fetcher.test.ts` fails if one appears here.
 */

/** The kinds of thing a store publishes that we can read without crawling. */
export type StoreContentKind = 'collection' | 'product' | 'page' | 'blog_article'

/**
 * One published thing, exactly as the store's admin interface described it.
 *
 * Deliberately flat and vendor-neutral: the mapping below turns this into a
 * row, and a second storefront would only need a second producer of these.
 */
export interface StoreContentRecord {
  readonly kind: StoreContentKind
  /** The storefront's own id, kept as text — external ids are never our keys. */
  readonly shopifyId: string
  /** The last segment of the public address. */
  readonly handle: string
  readonly title: string
  /** The published body, as markup. Null where the store left it empty. */
  readonly bodyHtml: string | null
  readonly seoTitle: string | null
  readonly seoDescription: string | null
  /** Blog articles live under their blog's handle, and their address needs it. */
  readonly blogHandle?: string
  /** Storefront ids of the products in this collection. Collections only. */
  readonly memberProductIds?: readonly string[]
  /** The storefront's own last-modified stamp, used to skip unchanged things. */
  readonly updatedAt?: string
}

/**
 * How far through the store a sync got, so the next run resumes rather than
 * restarts.
 *
 * Opaque on purpose: only the source that produced it knows what it means, and
 * a second storefront would number its pages differently. It is plain strings
 * because it travels through a job payload as JSON.
 */
export type InventoryCursor = Readonly<Record<string, string>>

export interface StoreContentBatch {
  readonly records: readonly StoreContentRecord[]
  /** Absent when the store has been walked to the end. */
  readonly next?: InventoryCursor
}

/**
 * Reads the store's published things in id order, a bounded batch at a time.
 *
 * Batched rather than all-at-once because a large store cannot be read inside
 * one job run: the storefront allows roughly one request a second, so a
 * thousand-page store is a twenty-minute walk and has to survive being killed
 * halfway.
 */
export interface StoreContentSource {
  /** The store's public address, e.g. `https://shop.example`. Every row's URL is built from it. */
  storefrontOrigin(accountId: string): Promise<string>
  next(accountId: string, cursor: InventoryCursor | undefined, limit: number): Promise<StoreContentBatch>
  /**
   * Re-reads named things, after the store said they changed. Things the store
   * no longer has come back missing rather than as an error.
   */
  read(accountId: string, targets: readonly InventoryTarget[]): Promise<readonly StoreContentRecord[]>
}

/** One thing to go and re-read: which kind, and the store's own id for it. */
export interface InventoryTarget {
  readonly kind: StoreContentKind
  readonly shopifyId: string
}

/** One inventory row, ready to be written. */
export interface StorePageRow {
  readonly url: string
  readonly pageType: 'collection' | 'product' | 'page' | 'blog_article' | 'article_ours' | 'other'
  readonly handle: string
  readonly shopifyId: string
  readonly title: string
  readonly seoTitle: string | null
  readonly seoDescription: string | null
  readonly headings: readonly string[]
  readonly bodyHtml: string | null
  readonly outboundInternalLinks: readonly string[]
  readonly familyIds: readonly string[]
  readonly checksum: string
}

/**
 * Where inventory rows land. A write reports whether the row's content actually
 * moved, which is what stops an unchanged page from re-scoring opportunities
 * every night.
 */
export interface StorePageWriter {
  /** The checksums we already hold, keyed by URL, for the URLs asked about. */
  knownChecksums(accountId: string, urls: readonly string[]): Promise<ReadonlyMap<string, string | null>>
  upsert(accountId: string, rows: readonly StorePageRow[]): Promise<void>
  /**
   * Records that the store served these addresses just now, whether or not
   * anything about them moved.
   *
   * Separate from `upsert`, which runs only for pages whose content changed —
   * an unchanged page is deliberately left alone so it does not look edited to
   * everything watching its checksum. That leaves "when did this row last
   * change" as the only thing the row knows, so answering "when did we last see
   * it" needs a write of its own.
   *
   * A page the walk found is by definition still served, so this also brings a
   * row back from `gone`. Without that, a page deleted and then restored would
   * stay marked gone for ever: the restored page carries the checksum it always
   * had, so nothing would upsert it.
   */
  markSeen(accountId: string, urls: readonly string[], at: Date): Promise<void>
  /**
   * Marks every page the walk did not find as gone, and answers how many.
   *
   * Only ever called with the start time of a walk that reached the end of the
   * store. A walk that ran out of budget, lost its connection or died has not
   * established that anything is missing — only that we stopped looking.
   */
  markGoneNotSeenSince(accountId: string, since: Date): Promise<number>
  /**
   * Records that these addresses hold articles we published, naming the article
   * each one came from.
   *
   * A write of its own for the same reason `markSeen` is one: `upsert` runs
   * only for pages whose words moved, and one of our own articles sitting
   * untouched on a merchant's blog never moves again after the night it
   * appeared. Riding on the content write would mean an article whose address
   * we learn late — a merchant telling us where they put a downloaded one — is
   * never recognised at all.
   */
  markOurs(
    accountId: string,
    pages: readonly { readonly url: string; readonly articleId: string }[],
  ): Promise<void>
}

/** One of our own articles that the shop has started serving somewhere else. */
export interface ArticleAddressMove {
  readonly articleId: string
  /** The address we hold for it, which the shop has stopped serving. */
  readonly from: string
  /** The address the shop serves the same post at now. */
  readonly to: string
}

/**
 * Where a move is written down.
 *
 * Two things have to change together and neither is any use alone: the address
 * we hold for the article — what the merchant clicks to read it, and what its
 * search performance is matched against — and the inventory row at the address
 * the shop has stopped serving, which would otherwise sit for ever claiming to
 * be a page of ours the store still publishes.
 */
export interface OurArticleAddressWriter {
  followRename(accountId: string, move: ArticleAddressMove): Promise<void>
}

/** One article we published for this store, and the address we hold for it. */
export interface PublishedArticleAddress {
  readonly articleId: string
  /**
   * Auto-publish records the address it posted to. Export mode records the
   * address the merchant told us they published at, which may be anywhere on
   * their own domain — including somewhere the walk never looks.
   */
  readonly url: string
}

/**
 * Which of a store's pages we wrote.
 *
 * There is nothing on a page that says whose it is: the store hands one of our
 * articles back as an ordinary blog post, with the merchant's own posts beside
 * it and no marking to tell them apart. Our record of where we published is the
 * only thing that can answer, so the walk asks it rather than inspecting the
 * page.
 */
export interface OurArticleLookup {
  publishedArticles(accountId: string): Promise<readonly PublishedArticleAddress[]>
  /**
   * The posts we made on the merchant's own shop, each with the id the shop
   * gave it.
   *
   * This is what lets the walk tell a rename from a new post: the address moves
   * and the id does not. Only auto-publish delivery produces one — an article a
   * merchant downloaded and pasted onto their own blog is, to the shop, a post
   * the merchant wrote, with nothing of ours attached — so this is empty for an
   * export-delivery store and a rename there still detaches the article from
   * its page.
   */
  publishedToShop(accountId: string): Promise<readonly ShopArticleOfOurs[]>
}

/** One article of ours that we posted to the merchant's shop ourselves. */
export interface ShopArticleOfOurs {
  readonly articleId: string
  /** The shop's own id for the post, kept from the publication claim. */
  readonly shopifyArticleId: string
}

/**
 * Which product family each product belongs to.
 *
 * Families are how everything downstream avoids treating forty similar shoes as
 * forty subjects, so a collection's families are the families of the products
 * in it, and a product's family is its own.
 */
export interface FamilyLookup {
  /** Family id per storefront product id. Products with no family are absent. */
  familiesForProducts(
    accountId: string,
    shopifyProductIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>
}
