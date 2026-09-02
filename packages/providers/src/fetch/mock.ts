import { PageFetchError, type PageFetchRequest, type PageFetchResult, type PageFetcher } from './types'

/**
 * The in-memory test double every consumer of the fetcher tests against. It
 * records what was asked for, so a test can assert the thing that matters most
 * about the preview cache: that a cache hit means no fetch happened at all.
 */
export class MockPageFetcher implements PageFetcher {
  /** Every URL this fetcher was asked for, in order. */
  readonly requested: string[] = []

  private readonly responses = new Map<string, PageFetchResult | PageFetchError>()
  private fallback: PageFetchResult | PageFetchError | undefined

  get callCount(): number {
    return this.requested.length
  }

  on(url: string, body: string, init: Partial<PageFetchResult> = {}): this {
    this.responses.set(url, {
      finalUrl: url,
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body,
      bytes: Buffer.byteLength(body),
      chain: [url],
      headers: {},
      ...init,
    })
    return this
  }

  failOn(url: string, error: PageFetchError): this {
    this.responses.set(url, error)
    return this
  }

  /** Answer for any URL with no specific response. Defaults to a 404-style failure. */
  setDefault(result: PageFetchResult | PageFetchError): this {
    this.fallback = result
    return this
  }

  reset(): void {
    this.requested.length = 0
    this.responses.clear()
    this.fallback = undefined
  }

  async fetch(request: PageFetchRequest): Promise<PageFetchResult> {
    this.requested.push(request.url)
    const answer =
      this.responses.get(request.url) ??
      this.fallback ??
      new PageFetchError('http_status', 'MockPageFetcher has no response for this URL.', request.url)
    if (answer instanceof PageFetchError) throw answer
    return answer
  }
}
