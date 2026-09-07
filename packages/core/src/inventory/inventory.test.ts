import { describe, expect, it } from 'vitest'
import { catalogEventsToTargets } from './events'
import { canonicalStoreUrl, extractHeadings, extractInternalLinks } from './html'
import { contentChecksum, storeUrlFor, toStorePageRow } from './pages'
import {
  resyncInventoryTargets,
  syncInventoryBatch,
  syncInventoryRecords,
  type InventorySyncDeps,
  type InventorySyncResult,
} from './sync'
import type {
  FamilyLookup,
  InventoryCursor,
  OurArticleAddressWriter,
  OurArticleLookup,
  StoreContentBatch,
  StoreContentRecord,
  StoreContentSource,
  StorePageRow,
  StorePageWriter,
} from './ports'

const ORIGIN = 'https://shop.example'

function record(over: Partial<StoreContentRecord> = {}): StoreContentRecord {
  return {
    kind: 'collection',
    shopifyId: '1',
    handle: 'boots',
    title: 'Boots',
    bodyHtml: '<p>Boots for the hills.</p>',
    seoTitle: 'Boots',
    seoDescription: 'Every boot we sell.',
    ...over,
  }
}

describe('reading a page body', () => {
  it('keeps headings in the order they appear', () => {
    const html = '<h1>Waterproof boots</h1><p>x</p><h2>How we <em>test</em> them</h2><h3>Fit</h3>'
    expect(extractHeadings(html)).toEqual(['Waterproof boots', 'How we test them', 'Fit'])
  })

  it('decodes the entities merchants actually type', () => {
    expect(extractHeadings('<h2>Boots &amp; shoes</h2>')).toEqual(['Boots & shoes'])
  })

  it('has no headings for an empty body', () => {
    expect(extractHeadings(null)).toEqual([])
  })

  it('keeps links to the store and drops everything else', () => {
    const html = [
      '<a href="/collections/boots">boots</a>',
      "<a href='https://shop.example/products/trailblazer?variant=9'>trailblazer</a>",
      '<a href="http://shop.example/pages/sizing">sizing</a>',
      '<a href="https://competitor.example/boots">them</a>',
      '<a href="mailto:hi@shop.example">mail</a>',
      '<a href="#top">top</a>',
    ].join('')
    expect(extractInternalLinks(html, ORIGIN)).toEqual([
      'https://shop.example/collections/boots',
      'https://shop.example/products/trailblazer',
      'https://shop.example/pages/sizing',
    ])
  })

  it('names each linked page once, however many times it is linked', () => {
    const html = '<a href="/collections/boots">a</a><a href="/collections/boots/">b</a>'
    expect(extractInternalLinks(html, ORIGIN)).toEqual(['https://shop.example/collections/boots'])
  })
})

describe('a page address', () => {
  it('is built from the storefront address and the handle, per kind', () => {
    expect(storeUrlFor(record({ kind: 'collection', handle: 'boots' }), ORIGIN)).toBe(
      'https://shop.example/collections/boots',
    )
    expect(storeUrlFor(record({ kind: 'product', handle: 'trailblazer' }), ORIGIN)).toBe(
      'https://shop.example/products/trailblazer',
    )
    expect(storeUrlFor(record({ kind: 'page', handle: 'about' }), ORIGIN)).toBe(
      'https://shop.example/pages/about',
    )
    expect(
      storeUrlFor(record({ kind: 'blog_article', handle: 'winter', blogHandle: 'journal' }), ORIGIN),
    ).toBe('https://shop.example/blogs/journal/winter')
  })

  it('drops the query string, so one page is one row', () => {
    expect(canonicalStoreUrl('/collections/boots?sort=price#top', ORIGIN)).toBe(
      'https://shop.example/collections/boots',
    )
  })
})

describe('the change detector', () => {
  it('moves when the body is edited', () => {
    const before = contentChecksum(record())
    const after = contentChecksum(record({ bodyHtml: '<p>Boots for the hills, and the moors.</p>' }))
    expect(after).not.toBe(before)
  })

  it('moves when a search field is edited', () => {
    expect(contentChecksum(record({ seoTitle: 'Walking boots' }))).not.toBe(
      contentChecksum(record()),
    )
    expect(contentChecksum(record({ seoDescription: 'All of them.' }))).not.toBe(
      contentChecksum(record()),
    )
  })

  it('stays put when nothing was edited', () => {
    expect(contentChecksum(record())).toBe(contentChecksum(record()))
  })

  it('cannot be fooled by moving text across the field boundary', () => {
    expect(contentChecksum(record({ title: 'Boots', handle: 'boots' }))).not.toBe(
      contentChecksum(record({ title: '', handle: 'bootsBoots' })),
    )
  })
})

describe('one inventory row', () => {
  it('carries the page type, the search fields, the headings and the internal links', () => {
    const row = toStorePageRow({
      record: record({
        kind: 'page',
        handle: 'sizing',
        title: 'Sizing guide',
        bodyHtml: '<h2>Width</h2><a href="/collections/boots">boots</a>',
      }),
      storefrontOrigin: ORIGIN,
      familyIds: ['fam-1'],
    })
    expect(row).toMatchObject({
      url: 'https://shop.example/pages/sizing',
      pageType: 'page',
      seoTitle: 'Boots',
      headings: ['Width'],
      outboundInternalLinks: ['https://shop.example/collections/boots'],
      familyIds: ['fam-1'],
    })
  })
})

class RecordingWriter implements StorePageWriter {
  readonly rows = new Map<string, StorePageRow>()
  readonly writes: StorePageRow[][] = []
  /** When each address was last seen — what the real table now records. */
  readonly seenAt = new Map<string, Date>()
  readonly gone = new Set<string>()
  /** Addresses recognised as articles we published, and which article each came from. */
  readonly ours = new Map<string, string>()
  /** Every sweep asked for, so a test can prove one never happened. */
  readonly sweeps: Date[] = []

  async knownChecksums(_accountId: string, urls: readonly string[]) {
    const out = new Map<string, string | null>()
    for (const url of urls) {
      const row = this.rows.get(url)
      if (row) out.set(url, row.checksum)
    }
    return out
  }

  async upsert(_accountId: string, rows: readonly StorePageRow[]) {
    this.writes.push([...rows])
    for (const row of rows) this.rows.set(row.url, row)
  }

  async markSeen(_accountId: string, urls: readonly string[], at: Date) {
    for (const url of urls) {
      this.seenAt.set(url, at)
      this.gone.delete(url)
    }
  }

  async markOurs(
    _accountId: string,
    pages: readonly { readonly url: string; readonly articleId: string }[],
  ) {
    for (const page of pages) this.ours.set(page.url, page.articleId)
  }

  async markGoneNotSeenSince(_accountId: string, since: Date) {
    this.sweeps.push(since)
    let marked = 0
    for (const [url, at] of this.seenAt) {
      // The table's own exclusion: an article of ours is never marked gone.
      if (this.ours.has(url)) continue
      if (at.getTime() >= since.getTime() || this.gone.has(url)) continue
      this.gone.add(url)
      marked += 1
    }
    return marked
  }

  /**
   * What the table does to the address a renamed post has left behind. Not a
   * port method: the row and the article's address move in one statement in the
   * repository, so the walk asks for the move and never for this on its own.
   */
  retire(url: string) {
    this.gone.add(url)
  }
}

/**
 * A store's published articles as the product holds them, plus the posts it
 * made on the shop itself.
 *
 * Mutable, because following a rename writes to it: a second walk has to see
 * the corrected address, which is exactly what a test asserting the link
 * survived is asking about.
 */
class OurArticles implements OurArticleLookup, OurArticleAddressWriter {
  /** Article id → the address we hold. Insertion order is oldest first. */
  private readonly addresses = new Map<string, string>()
  /** The shop's id for each post we made → the article behind it. */
  private readonly onShop = new Map<string, string>()
  readonly moves: { articleId: string; from: string; to: string }[] = []
  private writer: RecordingWriter | undefined

  constructor(pairs: readonly (readonly [string, string])[]) {
    for (const [url, articleId] of pairs) if (!this.addresses.has(articleId)) this.addresses.set(articleId, url)
  }

  /** Says these posts are ones we made on the shop, so the shop gave us an id. */
  postedToShop(...pairs: readonly (readonly [string, string])[]): this {
    for (const [shopifyArticleId, articleId] of pairs) this.onShop.set(shopifyArticleId, articleId)
    return this
  }

  /** Where the inventory row a rename leaves behind is retired. */
  retiring(writer: RecordingWriter): this {
    this.writer = writer
    return this
  }

  async publishedArticles() {
    return [...this.addresses].map(([articleId, url]) => ({ articleId, url }))
  }

  async publishedToShop() {
    return [...this.onShop].map(([shopifyArticleId, articleId]) => ({ shopifyArticleId, articleId }))
  }

  async followRename(_accountId: string, move: { articleId: string; from: string; to: string }) {
    this.moves.push(move)
    this.addresses.set(move.articleId, move.to)
    this.writer?.retire(move.from)
  }
}

const noFamilies: FamilyLookup = {
  async familiesForProducts() {
    return new Map()
  },
}

/** A store we have published nothing to yet. */
const nothingPublished = new OurArticles([])

/** A store where these addresses hold articles we published. */
function published(...pairs: readonly (readonly [string, string])[]): OurArticles {
  return new OurArticles(pairs)
}

function sourceOf(batches: readonly StoreContentBatch[], byTarget: readonly StoreContentRecord[] = []) {
  let call = 0
  const cursors: (InventoryCursor | undefined)[] = []
  const source: StoreContentSource = {
    async storefrontOrigin() {
      return ORIGIN
    },
    async next(_accountId, cursor) {
      cursors.push(cursor)
      return batches[call++] ?? { records: [] }
    },
    async read(_accountId, targets) {
      return byTarget.filter((candidate) =>
        targets.some(
          (target) => target.kind === candidate.kind && target.shopifyId === candidate.shopifyId,
        ),
      )
    },
  }
  return { cursors, source }
}

describe('walking a store into the inventory', () => {
  it('writes a row per published thing and reports where to resume', async () => {
    const { source } = sourceOf([
      {
        records: [
          record({ kind: 'collection', shopifyId: '1', handle: 'boots' }),
          record({ kind: 'page', shopifyId: '2', handle: 'about', bodyHtml: '<p>Us.</p>' }),
        ],
        next: { stage: 'page', sinceId: '2' },
      },
    ])
    const writer = new RecordingWriter()
    const deps: InventorySyncDeps = { source, writer, families: noFamilies, ourArticles: nothingPublished, articleAddresses: nothingPublished }

    const result = await syncInventoryBatch(deps, 'acc', undefined, 50)

    expect(result.seen).toBe(2)
    expect(result.changed).toBe(2)
    // The resume point, plus when this walk began — carried so the batch that
    // finishes the walk knows what "not seen on it" means.
    expect(result.next).toMatchObject({ stage: 'page', sinceId: '2' })
    expect(result.next?.['walkStartedAt']).toBeDefined()
    expect([...writer.rows.keys()].sort()).toEqual([
      'https://shop.example/collections/boots',
      'https://shop.example/pages/about',
    ])
  })

  it('writes nothing the second time round, and writes again once a body is edited', async () => {
    const writer = new RecordingWriter()
    const unchanged = sourceOf([{ records: [record()] }, { records: [record()] }])
    const deps: InventorySyncDeps = { source: unchanged.source, writer, families: noFamilies, ourArticles: nothingPublished, articleAddresses: nothingPublished }

    await syncInventoryBatch(deps, 'acc', undefined, 50)
    const second = await syncInventoryBatch(deps, 'acc', undefined, 50)
    expect(second.changed).toBe(0)
    expect(writer.writes).toHaveLength(1)

    const edited = await syncInventoryRecords(
      { source: unchanged.source, writer, families: noFamilies, ourArticles: nothingPublished, articleAddresses: nothingPublished },
      'acc',
      [record({ bodyHtml: '<p>Rewritten.</p>' })],
    )
    expect(edited.changed).toBe(1)
    expect(edited.changedUrls).toEqual(['https://shop.example/collections/boots'])
  })

  it("gives a collection the families of the products in it, and a product its own", async () => {
    const families: FamilyLookup = {
      async familiesForProducts(_accountId, ids) {
        const map = new Map<string, string>()
        if (ids.includes('p1')) map.set('p1', 'fam-hiking')
        if (ids.includes('p2')) map.set('p2', 'fam-town')
        return map
      },
    }
    const { source } = sourceOf([
      {
        records: [
          record({ kind: 'collection', shopifyId: 'c1', memberProductIds: ['p1', 'p2', 'p3'] }),
          record({ kind: 'product', shopifyId: 'p1', handle: 'trailblazer' }),
        ],
      },
    ])
    const writer = new RecordingWriter()

    await syncInventoryBatch({ source, writer, families, ourArticles: nothingPublished, articleAddresses: nothingPublished }, 'acc', undefined, 50)

    expect(writer.rows.get('https://shop.example/collections/boots')?.familyIds.slice().sort()).toEqual([
      'fam-hiking',
      'fam-town',
    ])
    expect(writer.rows.get('https://shop.example/products/trailblazer')?.familyIds).toEqual([
      'fam-hiking',
    ])
  })
})

describe('reacting to what the store says changed', () => {
  const at = (iso: string) => iso

  it('re-reads an edited blog post and an edited page within minutes, not overnight', () => {
    const fanout = catalogEventsToTargets([
      {
        accountId: 'acc',
        kind: 'article_updated',
        entityId: 'a1',
        occurredAt: at('2026-09-02T10:00:00Z'),
        changedFields: ['body_html'],
      },
      {
        accountId: 'acc',
        kind: 'page_updated',
        entityId: 'pg1',
        occurredAt: at('2026-09-02T10:01:00Z'),
        changedFields: ['body_html'],
      },
    ])
    expect(fanout.resync).toEqual([
      { kind: 'page', shopifyId: 'pg1' },
      { kind: 'blog_article', shopifyId: 'a1' },
    ])
    expect(fanout.removed).toEqual([])
  })

  it('treats a deleted blog post and a deleted page the way it treats a deleted product', () => {
    const fanout = catalogEventsToTargets([
      {
        accountId: 'acc',
        kind: 'article_updated',
        entityId: 'a1',
        occurredAt: at('2026-09-02T10:00:00Z'),
        changedFields: ['body_html'],
      },
      // The edit arrived first and the deletion second: re-reading a page that no
      // longer exists would spend a request to learn nothing.
      {
        accountId: 'acc',
        kind: 'article_deleted',
        entityId: 'a1',
        occurredAt: at('2026-09-02T10:05:00Z'),
        changedFields: [],
      },
      {
        accountId: 'acc',
        kind: 'page_deleted',
        entityId: 'pg1',
        occurredAt: at('2026-09-02T10:06:00Z'),
        changedFields: [],
      },
    ])
    expect(fanout.resync).toEqual([])
    expect(fanout.removed).toEqual([
      { kind: 'blog_article', shopifyId: 'a1' },
      { kind: 'page', shopifyId: 'pg1' },
    ])
  })

  it('re-reads the product and the collection, and ignores price and stock', () => {
    const fanout = catalogEventsToTargets([
      {
        accountId: 'acc',
        kind: 'product_updated',
        entityId: 'p1',
        occurredAt: at('2026-09-02T10:00:00Z'),
        changedFields: ['body_html'],
      },
      {
        accountId: 'acc',
        kind: 'collection_updated',
        entityId: 'c1',
        occurredAt: at('2026-09-02T10:01:00Z'),
        changedFields: ['body_html'],
      },
      {
        accountId: 'acc',
        kind: 'price_changed',
        entityId: 'p2',
        occurredAt: at('2026-09-02T10:02:00Z'),
        changedFields: ['price'],
      },
      {
        accountId: 'acc',
        kind: 'availability_changed',
        entityId: 'p3',
        occurredAt: at('2026-09-02T10:03:00Z'),
        changedFields: ['inventory_quantity'],
      },
    ])
    expect(fanout.resync).toEqual([
      { kind: 'collection', shopifyId: 'c1' },
      { kind: 'product', shopifyId: 'p1' },
    ])
    expect(fanout.removed).toEqual([])
  })

  it('names a thing once however many times it changed', () => {
    const fanout = catalogEventsToTargets([
      {
        accountId: 'acc',
        kind: 'product_updated',
        entityId: 'p1',
        occurredAt: at('2026-09-02T10:00:00Z'),
        changedFields: ['title'],
      },
      {
        accountId: 'acc',
        kind: 'product_updated',
        entityId: 'p1',
        occurredAt: at('2026-09-02T09:00:00Z'),
        changedFields: ['body_html'],
      },
    ])
    expect(fanout.resync).toEqual([{ kind: 'product', shopifyId: 'p1' }])
  })

  it('does not go and re-read something the store says is gone', () => {
    const fanout = catalogEventsToTargets([
      {
        accountId: 'acc',
        kind: 'product_updated',
        entityId: 'p1',
        occurredAt: at('2026-09-02T10:00:00Z'),
        changedFields: ['title'],
      },
      {
        accountId: 'acc',
        kind: 'product_deleted',
        entityId: 'p1',
        occurredAt: at('2026-09-02T10:05:00Z'),
        changedFields: [],
      },
    ])
    expect(fanout.resync).toEqual([])
    expect(fanout.removed).toEqual([{ kind: 'product', shopifyId: 'p1' }])
  })
})

describe('recognising an article we published', () => {
  const ARTICLE = 'e0a2f1c4-0000-4000-8000-000000000001'
  const OTHER_ARTICLE = 'e0a2f1c4-0000-4000-8000-000000000002'
  const OURS = 'https://shop.example/blogs/news/best-trail-shoes'

  function article(over: Partial<StoreContentRecord> = {}): StoreContentRecord {
    return record({
      kind: 'blog_article',
      shopifyId: '61',
      handle: 'best-trail-shoes',
      blogHandle: 'news',
      title: 'Best trail shoes',
      ...over,
    })
  }

  /** One walk of `records` against a store we published `pairs` to. */
  async function walk(
    writer: RecordingWriter,
    records: readonly StoreContentRecord[],
    ourArticles: OurArticles,
  ): Promise<InventorySyncResult> {
    const { source } = sourceOf([{ records }])
    return syncInventoryBatch(
      { source, writer, families: noFamilies, ourArticles, articleAddresses: ourArticles },
      'acc',
      undefined,
      50,
    )
  }

  it('marks the post the store hands back as ours, and names the article it came from', async () => {
    const writer = new RecordingWriter()

    const result = await walk(writer, [article()], published([OURS, ARTICLE]))

    expect(result.markedOurs).toBe(1)
    expect(writer.ours.get(OURS)).toBe(ARTICLE)
  })

  it("never marks a post the merchant wrote themselves", async () => {
    const writer = new RecordingWriter()

    const result = await walk(
      writer,
      [article({ shopifyId: '62', handle: 'our-shop-turns-ten', title: 'Our shop turns ten' })],
      published([OURS, ARTICLE]),
    )

    expect(result.markedOurs).toBe(0)
    expect([...writer.ours.keys()]).toEqual([])
  })

  it('marks nothing at all for a store we have published nothing to', async () => {
    const writer = new RecordingWriter()

    const result = await walk(writer, [article()], nothingPublished)

    expect(result.markedOurs).toBe(0)
  })

  it('recognises the same post again on a night when nothing about it changed', async () => {
    const writer = new RecordingWriter()
    const ours = published([OURS, ARTICLE])

    const first = await walk(writer, [article()], ours)
    const second = await walk(writer, [article()], ours)

    // The second walk writes no content — the post is untouched — and still
    // recognises it. If recognition rode on the content write it would happen
    // once and then silently stop.
    expect(first.changed).toBe(1)
    expect(second.changed).toBe(0)
    expect(second.markedOurs).toBe(1)
    expect(writer.ours.get(OURS)).toBe(ARTICLE)
  })

  it('recognises a post it has already walked, once the merchant tells us where they published it', async () => {
    const writer = new RecordingWriter()

    // Export delivery: the merchant downloads the article, publishes it on
    // their own blog, and only tells us the address afterwards. By then the
    // walk has long since filed the post as one of theirs.
    await walk(writer, [article()], nothingPublished)
    expect(writer.ours.size).toBe(0)

    const later = await walk(writer, [article()], published([OURS, ARTICLE]))

    expect(later.changed).toBe(0)
    expect(later.markedOurs).toBe(1)
    expect(writer.ours.get(OURS)).toBe(ARTICLE)
  })

  it('reads through a trailing slash and a tracking parameter on an address a merchant typed', async () => {
    const writer = new RecordingWriter()

    const result = await walk(
      writer,
      [article()],
      published([`${OURS}/?utm_source=newsletter`, ARTICLE]),
    )

    expect(result.markedOurs).toBe(1)
    expect(writer.ours.get(OURS)).toBe(ARTICLE)
  })

  it('leaves an article published somewhere the walk cannot see unrecognised, and marks nothing else instead', async () => {
    const writer = new RecordingWriter()

    // An export-delivery store that publishes on a site we have no connection
    // to. Nothing on this shop is that article, and guessing at the nearest
    // post would put a rewrite request against a page the merchant wrote.
    const result = await walk(
      writer,
      [article()],
      published(['https://journal.elsewhere.example/best-trail-shoes', ARTICLE]),
    )

    expect(result.markedOurs).toBe(0)
    expect([...writer.ours.keys()]).toEqual([])
  })

  it('settles on the same article every night when two claim one address', async () => {
    const writer = new RecordingWriter()
    // The lookup hands them over oldest first, and the walk keeps the first.
    const ours = published([OURS, ARTICLE], [OURS, OTHER_ARTICLE])

    await walk(writer, [article()], ours)
    const again = await walk(writer, [article()], ours)

    expect(again.markedOurs).toBe(1)
    expect(writer.ours.get(OURS)).toBe(ARTICLE)
  })

  it('recognises a post the store told us it had just changed, without waiting for the nightly walk', async () => {
    const writer = new RecordingWriter()
    const { source } = sourceOf([], [article()])
    const ours = published([OURS, ARTICLE])

    const result = await resyncInventoryTargets(
      {
        source,
        writer,
        families: noFamilies,
        ourArticles: ours,
        articleAddresses: ours,
      },
      'acc',
      [{ kind: 'blog_article', shopifyId: '61' }],
    )

    expect(result.markedOurs).toBe(1)
    expect(writer.ours.get(OURS)).toBe(ARTICLE)
  })
})

describe('a merchant renaming one of our published articles', () => {
  const ARTICLE = 'e0a2f1c4-0000-4000-8000-000000000001'
  /** Shopify's own id for the post we made. It survives the rename; the address does not. */
  const SHOP_POST = '61'
  const BEFORE = 'https://shop.example/blogs/news/best-trail-shoes'
  const AFTER = 'https://shop.example/blogs/news/best-walking-shoes'

  function article(over: Partial<StoreContentRecord> = {}): StoreContentRecord {
    return record({
      kind: 'blog_article',
      shopifyId: SHOP_POST,
      handle: 'best-trail-shoes',
      blogHandle: 'news',
      title: 'Best trail shoes',
      ...over,
    })
  }

  const renamed = article({ handle: 'best-walking-shoes' })

  /** A store we auto-published this article to, and which has recognised it. */
  async function settled(writer: RecordingWriter): Promise<OurArticles> {
    const ours = published([BEFORE, ARTICLE]).postedToShop([SHOP_POST, ARTICLE]).retiring(writer)
    const { source } = sourceOf([{ records: [article()] }])
    await syncInventoryBatch(
      { source, writer, families: noFamilies, ourArticles: ours, articleAddresses: ours },
      'acc',
      undefined,
      50,
    )
    return ours
  }

  /** What the shop's own `articles/update` message makes the walk do. */
  async function receiveRename(
    writer: RecordingWriter,
    ours: OurArticles,
    record: StoreContentRecord = renamed,
  ): Promise<InventorySyncResult> {
    const { source } = sourceOf([], [record])
    return resyncInventoryTargets(
      { source, writer, families: noFamilies, ourArticles: ours, articleAddresses: ours },
      'acc',
      [{ kind: 'blog_article', shopifyId: record.shopifyId }],
    )
  }

  it('follows the post to the address the shop now serves it at', async () => {
    const writer = new RecordingWriter()
    const ours = await settled(writer)
    expect(writer.ours.get(BEFORE)).toBe(ARTICLE)

    const result = await receiveRename(writer, ours)

    expect(result.followedRenames).toBe(1)
    expect(ours.moves).toEqual([{ articleId: ARTICLE, from: BEFORE, to: AFTER }])
    // The link the merchant clicks, and the address search performance is
    // matched against, now name the page the shop actually serves.
    expect(await ours.publishedArticles()).toEqual([{ articleId: ARTICLE, url: AFTER }])
  })

  it('recognises the post at its new address on the same pass', async () => {
    const writer = new RecordingWriter()
    const ours = await settled(writer)

    const result = await receiveRename(writer, ours)

    // Not a day later: an improve-this-page press against the new address in
    // the meantime would hand the merchant a list of edits for words we wrote.
    expect(result.markedOurs).toBe(1)
    expect(writer.ours.get(AFTER)).toBe(ARTICLE)
  })

  it('stops calling the address the shop has abandoned a live page', async () => {
    const writer = new RecordingWriter()
    const ours = await settled(writer)
    expect([...writer.gone]).toEqual([])

    await receiveRename(writer, ours)

    // Our own articles are exempt from the nightly deletion sweep, so nothing
    // else would ever retire this row and it would sit `live` for ever at an
    // address nobody can open.
    expect([...writer.gone]).toEqual([BEFORE])
  })

  it('follows the rename once, however many times the store is walked', async () => {
    const writer = new RecordingWriter()
    const ours = await settled(writer)
    await receiveRename(writer, ours)

    const again = await receiveRename(writer, ours)

    expect(again.followedRenames).toBe(0)
    expect(ours.moves).toHaveLength(1)
    expect(again.markedOurs).toBe(1)
  })

  it('leaves a post the merchant wrote themselves alone', async () => {
    const writer = new RecordingWriter()
    const ours = await settled(writer)

    // Same blog, a post of theirs, edited on the same night. Nothing about it
    // is ours, and moving our article's address onto it would claim their
    // writing as ours.
    const result = await receiveRename(
      writer,
      ours,
      article({ shopifyId: '62', handle: 'our-shop-turns-ten', title: 'Our shop turns ten' }),
    )

    expect(result.followedRenames).toBe(0)
    expect(ours.moves).toEqual([])
    expect(await ours.publishedArticles()).toEqual([{ articleId: ARTICLE, url: BEFORE }])
  })

  it('cannot follow a rename on a store we deliver to by export, and changes nothing there', async () => {
    const writer = new RecordingWriter()
    // The merchant downloaded the article and pasted it onto their own blog, so
    // the shop believes they wrote the post and gave us no id for it. This is
    // the half of the problem the notification cannot reach, and export is the
    // default delivery mode.
    const ours = published([BEFORE, ARTICLE]).retiring(writer)
    const { source } = sourceOf([{ records: [article()] }])
    await syncInventoryBatch(
      { source, writer, families: noFamilies, ourArticles: ours, articleAddresses: ours },
      'acc',
      undefined,
      50,
    )

    const result = await receiveRename(writer, ours)

    expect(result.followedRenames).toBe(0)
    expect(result.markedOurs).toBe(0)
    expect(await ours.publishedArticles()).toEqual([{ articleId: ARTICLE, url: BEFORE }])
    expect([...writer.gone]).toEqual([])
  })

  it('does not invent an address for a post we hold none for', async () => {
    const writer = new RecordingWriter()
    // An article posted as a shop draft has no address a reader could open, so
    // we hold none for it. Filling one in is a different question from
    // correcting one, and nobody has asked it. The store has another article
    // with an address, so this is the article being skipped rather than the
    // whole store having nothing published.
    const other = 'e0a2f1c4-0000-4000-8000-000000000002'
    const ours = published(['https://shop.example/blogs/news/older', other])
      .postedToShop([SHOP_POST, ARTICLE])
      .retiring(writer)

    const result = await receiveRename(writer, ours)

    expect(result.followedRenames).toBe(0)
    expect(ours.moves).toEqual([])
    expect(await ours.publishedArticles()).toEqual([
      { articleId: other, url: 'https://shop.example/blogs/news/older' },
    ])
  })
})

describe('noticing that a merchant deleted a page', () => {
  const on = (iso: string) => new Date(iso)
  const T0 = on('2026-09-07T03:00:00Z')
  const T1 = on('2026-09-08T03:00:00Z')

  /** A walk of `records`, run to its end, at the given moment. */
  async function walk(
    writer: RecordingWriter,
    records: readonly StoreContentRecord[],
    now: Date,
  ): Promise<InventorySyncResult> {
    const { source } = sourceOf([{ records }])
    return syncInventoryBatch({ source, writer, families: noFamilies, ourArticles: nothingPublished, articleAddresses: nothingPublished, now: () => now }, 'acc', undefined, 50)
  }

  it('marks a page the store has stopped serving, and leaves the rest alone', async () => {
    const writer = new RecordingWriter()
    await walk(
      writer,
      [record({ shopifyId: '1', handle: 'boots' }), record({ shopifyId: '2', handle: 'hats' })],
      T0,
    )
    expect([...writer.gone]).toEqual([])

    const result = await walk(writer, [record({ shopifyId: '1', handle: 'boots' })], T1)

    expect(result.markedGone).toBe(1)
    expect([...writer.gone]).toEqual(['https://shop.example/collections/hats'])
  })

  it('marks nothing when the walk did not reach the end of the store', async () => {
    const writer = new RecordingWriter()
    await walk(writer, [record({ shopifyId: '1', handle: 'boots' })], T0)
    const sweepsAfterSetup = writer.sweeps.length

    const { source } = sourceOf([
      { records: [record({ shopifyId: '2', handle: 'hats' })], next: { stage: 'page' } },
    ])
    const result = await syncInventoryBatch(
      { source, writer, families: noFamilies, ourArticles: nothingPublished, articleAddresses: nothingPublished, now: () => T1 },
      'acc',
      undefined,
      50,
    )

    // The founder's own reason for rejecting single-pass inference: an
    // interrupted walk has not looked at the rest of the store, so the boots
    // collection it never reached is not evidence of anything.
    expect(result.markedGone).toBeUndefined()
    expect(writer.sweeps).toHaveLength(sweepsAfterSetup)
    expect([...writer.gone]).toEqual([])
  })

  it('judges absence against when the walk started, not when it ended', async () => {
    const writer = new RecordingWriter()
    await walk(writer, [record({ shopifyId: '1', handle: 'boots' })], T0)
    const sweepsAfterSetup = writer.sweeps.length

    // A walk begun on one day and finished on the next — a large store, or one
    // whose walk was interrupted. The clock moves between the two batches, so
    // reading the finish time instead of the start time gives a different and
    // wrong answer.
    const clock = { now: T1 }
    const { source } = sourceOf([
      { records: [record({ shopifyId: '1', handle: 'boots' })], next: { stage: 'page' } },
      { records: [record({ shopifyId: '2', handle: 'hats' })] },
    ])
    const deps = { source, writer, families: noFamilies, ourArticles: nothingPublished, articleAddresses: nothingPublished, now: () => clock.now }

    const first = await syncInventoryBatch(deps, 'acc', undefined, 50)
    clock.now = on('2026-09-09T03:00:00Z')
    const second = await syncInventoryBatch(deps, 'acc', first.next, 50)

    // The boots collection was read on the first batch and stamped then. Judged
    // against the walk's start it is present; judged against the finish it looks
    // a day stale and would be wrongly marked gone.
    expect(second.markedGone).toBe(0)
    expect([...writer.gone]).toEqual([])
    expect(writer.sweeps).toHaveLength(sweepsAfterSetup + 1)
    expect(writer.sweeps.at(-1)).toEqual(T1)
  })

  it('marks the same absent page once, however often the walk runs', async () => {
    const writer = new RecordingWriter()
    await walk(writer, [record({ shopifyId: '1', handle: 'boots' })], T0)

    const first = await walk(writer, [], T1)
    const second = await walk(writer, [], on('2026-09-09T03:00:00Z'))

    expect(first.markedGone).toBe(1)
    expect(second.markedGone).toBe(0)
    expect([...writer.gone]).toEqual(['https://shop.example/collections/boots'])
  })

  it('brings a page back when the merchant restores it unchanged', async () => {
    const writer = new RecordingWriter()
    await walk(writer, [record({ shopifyId: '1', handle: 'boots' })], T0)
    await walk(writer, [], T1)
    expect([...writer.gone]).toEqual(['https://shop.example/collections/boots'])

    // Restored with the body it always had, so nothing about it has changed and
    // the checksum diff writes nothing. Being served is what makes it live.
    const restored = await walk(writer, [record({ shopifyId: '1', handle: 'boots' })], on('2026-09-09T03:00:00Z'))

    expect(restored.changed).toBe(0)
    expect([...writer.gone]).toEqual([])
  })

  it('never concludes anything is missing from a webhook re-read', async () => {
    const writer = new RecordingWriter()
    await walk(writer, [record({ shopifyId: '1', handle: 'boots' }), record({ shopifyId: '2', handle: 'hats' })], T0)
    const sweepsAfterSetup = writer.sweeps.length

    const { source } = sourceOf([], [record({ shopifyId: '1', handle: 'boots' })])
    const result = await resyncInventoryTargets(
      { source, writer, families: noFamilies, ourArticles: nothingPublished, articleAddresses: nothingPublished, now: () => T1 },
      'acc',
      [{ kind: 'collection', shopifyId: '1' }],
    )

    // Reading one named page says nothing about the pages nobody asked about.
    expect(result.markedGone).toBeUndefined()
    expect(writer.sweeps).toHaveLength(sweepsAfterSetup)
    expect([...writer.gone]).toEqual([])
  })
})
