import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MarkerLookupIncomplete } from '@sortiva/core'
import { ShopifyPublishClient } from './publish'

/**
 * Posting to a shop, driven against a real HTTP server standing in for
 * Shopify's Admin API.
 *
 * The fake shop the job tests use answers our own vocabulary — blogs,
 * articles, markers. It cannot show what we actually put on the wire, and two
 * of the things this card had to prove are exactly that: that no article we
 * send carries a tag, and that a blog holding more posts than fit in one
 * response is read to the end rather than peeked at. Both are assertions about
 * requests, so they are made where the requests are.
 */

const API_KEY = 'test-api-key'
const SHOP = { shop: 'acme', accessToken: 'shpat_real' }

interface Recorded {
  method: string
  path: string
  body: Record<string, unknown> | undefined
}

let server: Server
let base: string
let recorded: Recorded[] = []
/** The blog's articles, in the order the fake Shopify hands them back. */
let blogArticles: { id: number; handle: string }[] = []
/** Which article ids carry our marker in a metafield. */
let markedArticles = new Set<number>()
let pageSize = 250

function client(options: { maxLookupPages?: number } = {}): ShopifyPublishClient {
  return new ShopifyPublishClient({
    apiKey: API_KEY,
    storeBaseUrl: () => base,
    // The pacing is the read client's, tested there. Left to sleep for real,
    // a case that reads three pages would take three seconds.
    limiter: { sleep: async () => {} },
    ...(options.maxLookupPages === undefined ? {} : { maxLookupPages: options.maxLookupPages }),
  })
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const url = new URL(req.url ?? '/', base)
      recorded.push({
        method: req.method ?? 'GET',
        path: `${url.pathname}${url.search}`,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
      })

      const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(body))
      }

      if (req.method === 'POST' && url.pathname.endsWith('/articles.json')) {
        json(200, { article: { id: 991, handle: 'best-bottles', published_at: '2026-09-03T09:00:00Z' } })
        return
      }
      if (req.method === 'PUT' && /\/articles\/\d+\.json$/.test(url.pathname)) {
        json(200, { article: { id: 991, handle: 'best-bottles', published_at: '2026-09-03T09:00:00Z' } })
        return
      }
      if (/\/articles\/(\d+)\/metafields\.json$/.test(url.pathname)) {
        const id = Number(/\/articles\/(\d+)\/metafields\.json$/.exec(url.pathname)![1])
        json(200, {
          metafields: markedArticles.has(id)
            ? [{ namespace: 'sortiva', key: 'external_id', value: 'sortiva-abc' }]
            : [],
        })
        return
      }
      if (req.method === 'GET' && url.pathname.endsWith('/articles.json')) {
        const offset = Number(url.searchParams.get('page_info') ?? '0')
        const page = blogArticles.slice(offset, offset + pageSize)
        const next = offset + pageSize
        const headers: Record<string, string> =
          next < blogArticles.length
            ? { link: `<${base}/articles.json?limit=250&page_info=${next}>; rel="next"` }
            : {}
        json(200, { articles: page }, headers)
        return
      }
      json(404, {})
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
  blogArticles = []
  markedArticles = new Set()
  pageSize = 250
})

const article = {
  ...SHOP,
  blogId: '77',
  blogHandle: 'news',
  storefrontDomain: 'acme.com',
  title: 'Best bottles',
  bodyHtml: '<p>Hello</p>',
  handle: 'best-bottles',
  summary: 'A summary.',
  marker: 'sortiva-abc',
  publishAs: 'live' as const,
}

/**
 * What a revision is allowed to carry. Spelled out rather than spread from
 * `article`, because the fields it leaves behind — the address, the published
 * state — are the point of the card: `UpdateArticleInput` has nowhere to put
 * them.
 */
const revision = {
  ...SHOP,
  blogId: '77',
  blogHandle: 'news',
  storefrontDomain: 'acme.com',
  title: 'Best bottles',
  bodyHtml: '<p>Hello</p>',
  summary: 'A summary.',
  marker: 'sortiva-abc',
}

describe('what we put on a merchant`s blog', () => {
  it('sends no tag with a new article — nothing of ours is visible to their shoppers', async () => {
    await client().createArticle(article)

    const sent = recorded.find((r) => r.method === 'POST')!
    const payload = sent.body!['article'] as Record<string, unknown>
    expect(Object.keys(payload)).not.toContain('tags')
    // Once, in the hidden field, and nowhere else: the marker used to be
    // written twice, and the second copy was the one shoppers could see.
    expect(JSON.stringify(sent.body).split('sortiva-abc')).toHaveLength(2)
  })

  it('sends no tag on a revision either, so the merchant`s own tags survive', async () => {
    await client().updateArticle({ ...revision, remoteArticleId: '991' })

    const sent = recorded.find((r) => r.method === 'PUT')!
    const payload = sent.body!['article'] as Record<string, unknown>
    expect(Object.keys(payload)).not.toContain('tags')
  })

  it('still carries our marker, in the field only we can see', async () => {
    await client().createArticle(article)

    const payload = recorded.find((r) => r.method === 'POST')!.body!['article'] as Record<
      string,
      unknown
    >
    expect(payload['metafields']).toEqual([
      {
        namespace: 'sortiva',
        key: 'external_id',
        type: 'single_line_text_field',
        value: 'sortiva-abc',
      },
    ])
  })

  it('records the address Shopify actually serves the post at — the blog`s name, not its number', async () => {
    const remote = await client().createArticle(article)
    expect(remote.url).toBe('https://acme.com/blogs/news/best-bottles')
    expect(remote.url).not.toContain('/blogs/77/')
  })

  /**
   * The address a shopper opens and the host we talk to Shopify through are
   * two different hosts, and only the first can ever be matched to a Search
   * Console row. The request still went to the shop; the address recorded did
   * not.
   */
  it('records the store`s own domain, while still talking to Shopify`s host', async () => {
    const remote = await client().createArticle(article)

    expect(remote.url).toBe('https://acme.com/blogs/news/best-bottles')
    expect(remote.url).not.toContain('myshopify')
    expect(recorded.find((r) => r.method === 'POST')!.path).toContain('/blogs/77/articles.json')
  })

  describe('a revision sends the words we wrote and nothing else', () => {
    /** Exactly the keys a revision may carry. A new one added here is a new thing we overwrite. */
    it('sends the title, the body, the summary and our own hidden marker — and no more', async () => {
      await client().updateArticle({ ...revision, remoteArticleId: '991' })

      const payload = recorded.find((r) => r.method === 'PUT')!.body!['article'] as Record<
        string,
        unknown
      >
      expect(Object.keys(payload).sort()).toEqual([
        'body_html',
        'id',
        'metafields',
        'summary_html',
        'title',
      ])
    })

    it('sends no address, so a post the merchant renamed keeps its name', async () => {
      await client().updateArticle({ ...revision, remoteArticleId: '991' })

      const payload = recorded.find((r) => r.method === 'PUT')!.body!['article'] as Record<
        string,
        unknown
      >
      expect(Object.keys(payload)).not.toContain('handle')
    })

    it('sends no published state, so a post the merchant took down stays down', async () => {
      await client().updateArticle({ ...revision, remoteArticleId: '991' })

      const payload = recorded.find((r) => r.method === 'PUT')!.body!['article'] as Record<
        string,
        unknown
      >
      expect(Object.keys(payload)).not.toContain('published')
      expect(Object.keys(payload)).not.toContain('published_at')
    })

    /**
     * The other half of the same decision: the store's live-or-draft setting is
     * how a *new* post should arrive, so it is still sent on a create.
     */
    it('still sends the address and the published state when the article is new', async () => {
      await client().createArticle({ ...article, publishAs: 'draft' })

      const payload = recorded.find((r) => r.method === 'POST')!.body!['article'] as Record<
        string,
        unknown
      >
      expect(payload['handle']).toBe('best-bottles')
      expect(payload['published']).toBe(false)
    })
  })
})

describe('asking whether our post already landed', () => {
  const lookup = {
    ...SHOP,
    blogId: '77',
    blogHandle: 'news',
    storefrontDomain: 'acme.com',
    marker: 'sortiva-abc',
    notBefore: new Date('2026-09-03T09:00:00.000Z'),
  }

  it('finds our post on a blog that holds more than one page of them', async () => {
    // 600 posts, ours last: the defect this card fixes is reading the first
    // page and concluding the post is not there.
    blogArticles = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, handle: `post-${i + 1}` }))
    markedArticles.add(600)

    const found = await client().findArticleByMarker(lookup)

    expect(found?.id).toBe('600')
    const listReads = recorded.filter((r) => r.path.includes('/articles.json?') && r.method === 'GET')
    expect(listReads.length).toBeGreaterThan(1)
  })

  it('asks only about posts written since we claimed the publication', async () => {
    blogArticles = [{ id: 1, handle: 'a' }]
    await client().findArticleByMarker(lookup)

    const first = recorded.find((r) => r.method === 'GET')!
    expect(first.path).toContain('created_at_min=')
  })

  it('answers "not there" only after reading the whole list', async () => {
    blogArticles = Array.from({ length: 400 }, (_, i) => ({ id: i + 1, handle: `post-${i + 1}` }))

    expect(await client().findArticleByMarker(lookup)).toBeUndefined()
    expect(recorded.filter((r) => r.path.includes('page_info='))).not.toHaveLength(0)
  })

  it('refuses to answer at all when it ran out of pages first', async () => {
    // "Not there" is what authorises posting the article again, so a search
    // that did not finish must not be allowed to say it.
    blogArticles = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, handle: `post-${i + 1}` }))
    markedArticles.add(600)

    await expect(client({ maxLookupPages: 1 }).findArticleByMarker(lookup)).rejects.toBeInstanceOf(
      MarkerLookupIncomplete,
    )
  })

  it('reads the marker from the hidden field rather than from the list', async () => {
    blogArticles = [{ id: 5, handle: 'ours' }]
    markedArticles.add(5)

    await client().findArticleByMarker(lookup)

    expect(recorded.some((r) => r.path.includes('/articles/5/metafields.json'))).toBe(true)
  })
})
