import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MarkerLookupIncomplete, RemoteArticleGone, staticShopifyAuth } from '@sortiva/core'
import { ShopifyQueryRejected } from './graphql'
import { ShopifyPublishClient } from './publish'

/**
 * Posting to a shop, driven against a real HTTP server standing in for
 * Shopify's Admin API.
 *
 * The fake shop the job tests use answers our own vocabulary — blogs,
 * articles, markers. It cannot show what we actually put on the wire, and
 * several of the things that have to hold are exactly that: that no article we
 * send carries a tag, that a revision overwrites only the words we wrote, and
 * that a shop holding more posts than fit in one answer is read to the end
 * rather than peeked at. Those are assertions about requests, so they are made
 * where the requests are.
 */

const CLIENT_ID = 'test-client-id'
const auth = staticShopifyAuth('acme', 'shpat_real')

interface Recorded {
  /** The name on the query or mutation, which is how the fake shop knows what was asked. */
  operation: string
  query: string
  variables: Record<string, unknown>
}

interface FakeArticle {
  id: number
  handle: string
  title: string
  isPublished: boolean
  blogHandle: string
  marker: string | null
}

let server: Server
let base: string
let recorded: Recorded[] = []
/** The shop's articles, in the order the fake Shopify hands them back. */
let articles: FakeArticle[] = []
let blogs: { id: number; title: string; handle: string }[] = []
let pageSize = 250
let nextArticleId = 991
/** Makes the fake shop answer the way Shopify does when it has dropped a search filter it did not understand. */
let ignoreSearchFilter = false

function client(options: { maxLookupPages?: number } = {}): ShopifyPublishClient {
  return new ShopifyPublishClient({
    clientId: CLIENT_ID,
    storeBaseUrl: () => base,
    // The pacing is the transport's, tested there. Left to sleep for real, a
    // case that reads three pages would take three seconds.
    limiter: { sleep: async () => {} },
    ...(options.maxLookupPages === undefined ? {} : { maxLookupPages: options.maxLookupPages }),
  })
}

/** An article as Shopify's GraphQL answers describe one. */
function articleNode(article: FakeArticle): unknown {
  return {
    id: `gid://shopify/Article/${article.id}`,
    handle: article.handle,
    title: article.title,
    isPublished: article.isPublished,
    blog: { id: 'gid://shopify/Blog/77', handle: article.blogHandle },
    marker: article.marker === null ? null : { value: article.marker },
  }
}

function markerOf(metafields: unknown): string | null {
  const fields = (metafields ?? []) as { key?: string; value?: string }[]
  return fields.find((field) => field.key === 'external_id')?.value ?? null
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = JSON.parse(raw) as { query: string; variables?: Record<string, unknown> }
      const operation = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? ''
      const variables = body.variables ?? {}
      recorded.push({ operation, query: body.query, variables })

      const answer = (data: unknown, extensions?: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data, ...(extensions ? { extensions } : {}) }))
      }

      if (operation === 'SortivaArticleCreate') {
        const input = variables['article'] as Record<string, unknown>
        const created: FakeArticle = {
          id: (nextArticleId += 1),
          handle: String(input['handle'] ?? ''),
          title: String(input['title'] ?? ''),
          isPublished: input['isPublished'] === true,
          blogHandle: 'news',
          marker: markerOf(input['metafields']),
        }
        articles.push(created)
        answer({ articleCreate: { article: articleNode(created), userErrors: [] } })
        return
      }

      if (operation === 'SortivaArticleUpdate') {
        const id = Number(String(variables['id']).split('/').pop())
        const existing = articles.find((article) => article.id === id)
        if (!existing) {
          answer({
            articleUpdate: {
              article: null,
              userErrors: [{ field: ['id'], message: 'Article not found', code: 'NOT_FOUND' }],
            },
          })
          return
        }
        const input = variables['article'] as Record<string, unknown>
        existing.title = String(input['title'] ?? existing.title)
        answer({ articleUpdate: { article: articleNode(existing), userErrors: [] } })
        return
      }

      if (operation === 'SortivaArticlesSince') {
        const offset = Number(variables['after'] ?? 0)
        const page = articles.slice(offset, offset + pageSize)
        const next = offset + pageSize
        answer(
          {
            articles: {
              pageInfo: { hasNextPage: next < articles.length, endCursor: String(next) },
              nodes: page.map(articleNode),
            },
          },
          ignoreSearchFilter
            ? { search: [{ warnings: [{ field: 'created_at', message: 'is not supported' }] }] }
            : undefined,
        )
        return
      }

      if (operation === 'SortivaBlogByHandle') {
        const handle = /handle:'([^']*)'/.exec(String(variables['query'] ?? ''))?.[1] ?? ''
        answer({
          blogs: {
            nodes: blogs
              .filter((blog) => blog.handle === handle)
              .map((blog) => ({ id: `gid://shopify/Blog/${blog.id}`, title: blog.title, handle: blog.handle })),
          },
        })
        return
      }

      if (operation === 'SortivaBlogCreate') {
        const input = variables['blog'] as { title?: string; handle?: string }
        const handle = String(input.handle ?? '')
        if (blogs.some((blog) => blog.handle === handle)) {
          answer({
            blogCreate: {
              blog: null,
              userErrors: [{ field: ['handle'], message: 'has already been taken' }],
            },
          })
          return
        }
        const created = { id: 77 + blogs.length, title: String(input.title ?? ''), handle }
        blogs.push(created)
        answer({
          blogCreate: {
            blog: { id: `gid://shopify/Blog/${created.id}`, title: created.title, handle: created.handle },
            userErrors: [],
          },
        })
        return
      }

      if (operation === 'SortivaBlogs') {
        answer({
          blogs: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: blogs.map((blog) => ({
              id: `gid://shopify/Blog/${blog.id}`,
              title: blog.title,
              handle: blog.handle,
            })),
          },
        })
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ errors: [{ message: `unknown operation ${operation}` }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('no port')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  recorded = []
  articles = []
  blogs = []
  pageSize = 250
  nextArticleId = 990
  ignoreSearchFilter = false
})

/** What the fake shop was sent for one operation — the last time it was asked. */
function sent(operation: string): Recorded {
  const match = recorded.filter((request) => request.operation === operation).at(-1)
  if (!match) throw new Error(`nothing was sent for ${operation}`)
  return match
}

/** The article input inside a create or update, which is what most of these assertions are about. */
function articleInput(operation: string): Record<string, unknown> {
  return sent(operation).variables['article'] as Record<string, unknown>
}

const article = {
  auth,
  blogId: '77',
  storefrontDomain: 'acme.com',
  title: 'Best bottles',
  bodyHtml: '<p>Hello</p>',
  handle: 'best-bottles',
  summary: 'A summary.',
  marker: 'sortiva-abc',
  publishAs: 'live' as const,
  author: 'Acme Candles',
}

/**
 * What a revision is allowed to carry. Spelled out rather than spread from
 * `article`, because the fields it leaves behind — the address, the published
 * state, the blog — are the point: `UpdateArticleInput` has nowhere to put
 * them.
 */
const revision = {
  auth,
  storefrontDomain: 'acme.com',
  title: 'Best bottles',
  bodyHtml: '<p>Hello</p>',
  summary: 'A summary.',
  marker: 'sortiva-abc',
}

describe('what we put on a merchant`s blog', () => {
  it('sends no tag with a new article — nothing of ours is visible to their shoppers', async () => {
    await client().createArticle(article)

    expect(Object.keys(articleInput('SortivaArticleCreate'))).not.toContain('tags')
    // Once, in the hidden field, and nowhere else: the marker used to be
    // written twice, and the second copy was the one shoppers could see.
    expect(JSON.stringify(sent('SortivaArticleCreate').variables).split('sortiva-abc')).toHaveLength(2)
  })

  it('sends no tag on a revision either, so the merchant`s own tags survive', async () => {
    await client().createArticle(article)
    await client().updateArticle({ ...revision, remoteArticleId: '991' })

    expect(Object.keys(articleInput('SortivaArticleUpdate'))).not.toContain('tags')
  })

  it('still carries our marker, in the field only we can see', async () => {
    await client().createArticle(article)

    expect(articleInput('SortivaArticleCreate')['metafields']).toEqual([
      {
        namespace: 'sortiva',
        key: 'external_id',
        type: 'single_line_text_field',
        value: 'sortiva-abc',
      },
    ])
  })

  it('puts the search title and description where every Shopify theme reads them', async () => {
    await client().createArticle({
      ...article,
      seoTitle: 'Best bottles for cold brew',
      seoDescription: 'Which bottle to pick.',
    })

    expect(articleInput('SortivaArticleCreate')['metafields']).toEqual([
      expect.objectContaining({ namespace: 'sortiva', key: 'external_id' }),
      expect.objectContaining({ namespace: 'global', key: 'title_tag', value: 'Best bottles for cold brew' }),
      expect.objectContaining({
        namespace: 'global',
        key: 'description_tag',
        value: 'Which bottle to pick.',
      }),
    ])
  })

  it('puts the store`s own name on the post, not ours', async () => {
    // Shopify requires a byline on every article. A merchant's blog should not
    // carry one naming a tool they use.
    await client().createArticle(article)

    expect(articleInput('SortivaArticleCreate')['author']).toEqual({ name: 'Acme Candles' })
  })

  it('records the address Shopify actually serves the post at — the blog`s name, not its number', async () => {
    const remote = await client().createArticle(article)

    expect(remote.url).toBe('https://acme.com/blogs/news/best-bottles')
    expect(remote.url).not.toContain('/blogs/77/')
  })

  /**
   * The address a shopper opens and the host we talk to Shopify through are
   * two different hosts, and only the first can ever be matched to a Search
   * Console row. The request still went to the shop, naming the blog by
   * Shopify's own id; the address recorded did not.
   */
  it('records the store`s own domain, while still talking to Shopify`s host', async () => {
    const remote = await client().createArticle(article)

    expect(remote.url).toBe('https://acme.com/blogs/news/best-bottles')
    expect(remote.url).not.toContain('myshopify')
    expect(articleInput('SortivaArticleCreate')['blogId']).toBe('gid://shopify/Blog/77')
  })

  it('records the address a draft will have once the merchant publishes it', async () => {
    // Nothing asks Shopify again after a merchant publishes a draft, so an
    // address left blank at posting time stayed blank for good and the
    // article's traffic was never counted as its own.
    const remote = await client().createArticle({ ...article, publishAs: 'draft' })

    expect(remote.published).toBe(false)
    expect(remote.url).toBe('https://acme.com/blogs/news/best-bottles')
  })

  describe('a revision sends the words we wrote and nothing else', () => {
    /** Exactly the keys a revision may carry. A new one added here is a new thing we overwrite. */
    it('sends the title, the body and the summary — and no more', async () => {
      await client().createArticle(article)
      await client().updateArticle({ ...revision, remoteArticleId: '991' })

      expect(Object.keys(articleInput('SortivaArticleUpdate')).sort()).toEqual([
        'body',
        'summary',
        'title',
      ])
      // The article is named alongside the changes rather than among them, and
      // the marker it already carries is left exactly as it was written.
      expect(sent('SortivaArticleUpdate').variables['id']).toBe('gid://shopify/Article/991')
    })

    it('sends no address, so a post the merchant renamed keeps its name', async () => {
      await client().createArticle(article)
      await client().updateArticle({ ...revision, remoteArticleId: '991' })

      expect(Object.keys(articleInput('SortivaArticleUpdate'))).not.toContain('handle')
    })

    it('sends no published state, so a post the merchant took down stays down', async () => {
      await client().createArticle(article)
      await client().updateArticle({ ...revision, remoteArticleId: '991' })

      const keys = Object.keys(articleInput('SortivaArticleUpdate'))
      expect(keys).not.toContain('isPublished')
      expect(keys).not.toContain('publishDate')
    })

    /**
     * The other half of the same decision: the store's live-or-draft setting is
     * how a *new* post should arrive, so it is still sent on a create.
     */
    it('still sends the address and the published state when the article is new', async () => {
      await client().createArticle({ ...article, publishAs: 'draft' })

      const payload = articleInput('SortivaArticleCreate')
      expect(payload['handle']).toBe('best-bottles')
      expect(payload['isPublished']).toBe(false)
    })

    it('refuses to put back an article the merchant deleted', async () => {
      // Silently re-creating it would be a post they never asked for and
      // cannot see coming.
      await expect(
        client().updateArticle({ ...revision, remoteArticleId: '4242' }),
      ).rejects.toBeInstanceOf(RemoteArticleGone)
      expect(recorded.some((request) => request.operation === 'SortivaArticleCreate')).toBe(false)
    })
  })
})

describe('asking whether our post already landed', () => {
  const lookup = {
    auth,
    storefrontDomain: 'acme.com',
    marker: 'sortiva-abc',
    notBefore: new Date('2026-09-03T09:00:00.000Z'),
  }

  function post(id: number, options: Partial<FakeArticle> = {}): FakeArticle {
    return {
      id,
      handle: `post-${id}`,
      title: `Post ${id}`,
      isPublished: true,
      blogHandle: 'news',
      marker: null,
      ...options,
    }
  }

  it('finds our post on a shop that holds more than one page of them', async () => {
    // 600 posts, ours last: the defect here would be reading the first page and
    // concluding the post is not there.
    articles = Array.from({ length: 600 }, (_unused, i) => post(i + 1))
    articles[599] = post(600, { marker: 'sortiva-abc' })

    const found = await client().findArticleByMarker(lookup)

    expect(found?.id).toBe('600')
    expect(recorded.filter((request) => request.operation === 'SortivaArticlesSince').length).toBeGreaterThan(
      1,
    )
  })

  it('asks only about posts written since we claimed the publication', async () => {
    articles = [post(1)]
    await client().findArticleByMarker(lookup)

    const asked = String(sent('SortivaArticlesSince').variables['query'])
    expect(asked).toContain('created_at:>=')
    // Reaching a little further back than the claim, because Shopify's clock is
    // not ours: a post dated fractionally before the claim would otherwise be
    // stepped over, and "not found" is what authorises posting again.
    expect(asked).toContain('2026-09-03T08:55:00.000Z')
  })

  it('looks across the whole shop, not only the blog we would post to now', async () => {
    // The post went to whichever blog was chosen at the time, and the merchant
    // may have chosen a different one since. Searching only the current target
    // is how a crash either side of that change posts the same article twice.
    articles = [post(5, { marker: 'sortiva-abc', blogHandle: 'stories' })]

    const found = await client().findArticleByMarker(lookup)

    expect(found?.blogHandle).toBe('stories')
    expect(String(sent('SortivaArticlesSince').variables['query'])).not.toContain('blog')
  })

  it('answers "not there" only after reading the whole list', async () => {
    articles = Array.from({ length: 400 }, (_unused, i) => post(i + 1))

    expect(await client().findArticleByMarker(lookup)).toBeUndefined()
    // The second page was asked for, and asked for from where the first ended.
    const reads = recorded.filter((request) => request.operation === 'SortivaArticlesSince')
    expect(reads).toHaveLength(2)
    expect(reads[1]!.variables['after']).toBe('250')
  })

  it('refuses to answer at all when it ran out of pages first', async () => {
    // "Not there" is what authorises posting the article again, so a search
    // that did not finish must not be allowed to say it.
    articles = Array.from({ length: 600 }, (_unused, i) => post(i + 1))
    articles[599] = post(600, { marker: 'sortiva-abc' })

    await expect(client({ maxLookupPages: 1 }).findArticleByMarker(lookup)).rejects.toBeInstanceOf(
      MarkerLookupIncomplete,
    )
  })

  it('refuses to answer when Shopify ignored the "since we started" filter', async () => {
    // A dropped filter hands back the oldest posts on the shop instead. A
    // search that then found nothing would authorise posting again.
    ignoreSearchFilter = true
    articles = [post(5, { marker: 'sortiva-abc' })]

    await expect(client().findArticleByMarker(lookup)).rejects.toBeInstanceOf(ShopifyQueryRejected)
  })

  it('reads the marker from the hidden field rather than from the list', async () => {
    articles = [post(5, { marker: 'sortiva-abc' })]

    const found = await client().findArticleByMarker(lookup)

    expect(found?.id).toBe('5')
    expect(sent('SortivaArticlesSince').query).toContain('metafield(namespace: "sortiva", key: "external_id")')
    // And it arrives with the post: asking per article is what made this
    // question too expensive to ask on an established shop.
    expect(recorded).toHaveLength(1)
  })
})

describe('giving a store its first blog', () => {
  it('answers with the blog that is already there rather than adding a second', async () => {
    const first = await client().createBlog({ auth, title: 'News' })
    const second = await client().createBlog({ auth, title: 'News' })

    expect(second.id).toBe(first.id)
    expect(blogs).toHaveLength(1)
    expect(recorded.filter((request) => request.operation === 'SortivaBlogCreate')).toHaveLength(1)
  })

  it('leaves one blog behind when two clicks land at the same moment', async () => {
    // Both find no blog, both try to create one; the loser is told the handle
    // is taken, and the blog it wanted is now there.
    const publisher = client()
    const [first, second] = await Promise.all([
      publisher.createBlog({ auth, title: 'News' }),
      publisher.createBlog({ auth, title: 'News' }),
    ])

    expect(blogs).toHaveLength(1)
    expect(second.id).toBe(first.id)
    expect(second.handle).toBe('news')
  })
})
