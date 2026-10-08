import { describe, expect, it } from 'vitest'
import { AccessLostError, PermissionLostError, type StoreConnector } from '../types.ts'

export type Backend = {
  connector: StoreConnector
  /** A connector whose stored token has been replaced by a dead one, with no way to renew it. */
  deadTokenConnector: () => Promise<StoreConnector>
  /** Present only where a scope can be withdrawn on demand (the fake). */
  withoutScope?: (scope: string) => Promise<{ connector: StoreConnector; restore: () => Promise<void> }>
  /** The version header of the last answer. */
  lastApiVersion: () => string | null
  pinnedVersion: string
  /** Remove what earlier runs created; the dev store holds nothing else. */
  cleanUp: () => Promise<void>
}

/**
 * The behaviours the product relies on, written once. Against the fake they run on every commit;
 * against the dev store they run on demand. A pass on the fake and a failure on the real store
 * means the fake is wrong, and the fake is what gets fixed.
 */
export function describeConnectorBehaviour(name: string, backend: () => Backend) {
  describe(`Shopify connector behaviour: ${name}`, () => {
    const marker = `contract-${Date.now()}`
    let blogId = ''
    let articleId = ''

    it('answers with the pinned API version', async () => {
      await backend().cleanUp()
      await backend().connector.shopInfo()
      expect(backend().lastApiVersion()).toBe(backend().pinnedVersion)
    })

    it('pages through every product exactly once', async () => {
      const { connector } = backend()
      const total = await connector.productCount()
      const seen = new Set<string>()
      let cursor: string | null = null
      do {
        const page = await connector.productsPage(cursor, 2)
        for (const product of page.items) {
          expect(seen.has(product.platformId)).toBe(false)
          seen.add(product.platformId)
        }
        cursor = page.nextCursor
      } while (cursor)
      expect(seen.size).toBe(total)
    })

    it('reads one product by id, and answers null for an id that does not exist', async () => {
      const { connector } = backend()
      const first = (await connector.productsPage(null, 1)).items[0]!
      expect((await connector.product(first.platformId))?.title).toBe(first.title)
      expect(await connector.product('gid://shopify/Product/1')).toBeNull()
    })

    it('creates a blog and a hidden article carrying our marker', async () => {
      const { connector } = backend()
      blogId = (await connector.createBlog(`Contract ${marker}`)).platformId
      const created = await connector.createArticle({
        blogId,
        title: `Contract article ${marker}`,
        handle: marker,
        bodyHtml: '<p>Contract test body.</p>',
        summaryHtml: '<p>Contract test.</p>',
        published: false,
        author: 'Sortiva contract test',
        marker,
      })
      articleId = created.remoteId
      expect(created.published).toBe(false)
      expect((await connector.article(articleId))?.marker).toBe(marker)
    })

    it('finds the article by its marker', async () => {
      const deadline = Date.now() + 30_000
      let found = null
      while (!found && Date.now() < deadline) {
        found = await backend().connector.findArticleByMarker(marker, new Date(Date.now() - 3_600_000))
        if (!found) await new Promise((r) => setTimeout(r, 1_000))
      }
      expect(found?.remoteId).toBe(articleId)
    })

    it('updates the article by id, and reports an id that does not exist instead of creating one', async () => {
      const { connector } = backend()
      const updated = await connector.updateArticle(articleId, { bodyHtml: '<p>Updated body.</p>' })
      expect(updated).not.toBe('not_found')
      expect((await connector.article(articleId))?.bodyHtml).toContain('Updated body.')
      expect(await connector.updateArticle('gid://shopify/Article/1', { bodyHtml: '<p>x</p>' })).toBe('not_found')
    })

    it('a dead token that cannot be renewed is an access error', async () => {
      const connector = await backend().deadTokenConnector()
      await expect(connector.shopInfo()).rejects.toBeInstanceOf(AccessLostError)
    })

    it('a withdrawn permission is a permission error naming the scope', async ({ skip }) => {
      if (!backend().withoutScope) skip()
      const { connector, restore } = await backend().withoutScope!('read_products')
      try {
        const error = await connector.productsPage(null, 1).catch((e) => e)
        expect(error).toBeInstanceOf(PermissionLostError)
        expect((error as PermissionLostError).scope).toBe('read_products')
      } finally {
        await restore()
      }
    })
  })
}
