import { describe, expect, it } from 'vitest'
import { catalogEventsToTargets } from './events'
import { canonicalStoreUrl, extractHeadings, extractInternalLinks } from './html'
import { contentChecksum, storeUrlFor, toStorePageRow } from './pages'
import { syncInventoryBatch, syncInventoryRecords, type InventorySyncDeps } from './sync'
import type {
  FamilyLookup,
  InventoryCursor,
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
}

const noFamilies: FamilyLookup = {
  async familiesForProducts() {
    return new Map()
  },
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
    const deps: InventorySyncDeps = { source, writer, families: noFamilies }

    const result = await syncInventoryBatch(deps, 'acc', undefined, 50)

    expect(result.seen).toBe(2)
    expect(result.changed).toBe(2)
    expect(result.next).toEqual({ stage: 'page', sinceId: '2' })
    expect([...writer.rows.keys()].sort()).toEqual([
      'https://shop.example/collections/boots',
      'https://shop.example/pages/about',
    ])
  })

  it('writes nothing the second time round, and writes again once a body is edited', async () => {
    const writer = new RecordingWriter()
    const unchanged = sourceOf([{ records: [record()] }, { records: [record()] }])
    const deps: InventorySyncDeps = { source: unchanged.source, writer, families: noFamilies }

    await syncInventoryBatch(deps, 'acc', undefined, 50)
    const second = await syncInventoryBatch(deps, 'acc', undefined, 50)
    expect(second.changed).toBe(0)
    expect(writer.writes).toHaveLength(1)

    const edited = await syncInventoryRecords(
      { source: unchanged.source, writer, families: noFamilies },
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

    await syncInventoryBatch({ source, writer, families }, 'acc', undefined, 50)

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
