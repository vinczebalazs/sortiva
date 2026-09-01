/**
 * Billable vendor reads and LLM calls are cached at request level and **written
 * before the response is
 * processed**, so a crash after the vendor answered but before we finished with
 * the answer replays from cache on retry and never re-bills.
 *
 * The port lives here rather than in `packages/db` so the LLM and SEO wrappers
 * depend on the behaviour, not on Postgres; `PostgresRequestCache`
 * (`@sortiva/db`) is the production adapter and `InMemoryRequestCache` below is
 * the test double the wrappers' own suites run against.
 */

export interface RequestCacheEntry {
  /** Canonical key. LLM: `(prompt_version, model_id, sha256(prompt))`. SEO: `(endpoint, sha256(canonical_params))`. */
  readonly cacheKey: string
  /** `llm` | `dataforseo` — separates the two kinds of paid call for retention and cost reporting. */
  readonly kind: string
  readonly responseJson: unknown
  readonly expiresAt: Date
}

export interface RequestCache {
  /** Returns the stored response, or undefined when absent or expired. */
  read(cacheKey: string): Promise<RequestCacheEntry | undefined>
  /**
   * Stores the raw vendor response. Called immediately on receipt, *before* any
   * parsing, validation or downstream work — that ordering is the whole point.
   */
  writeBeforeProcessing(entry: RequestCacheEntry): Promise<void>
}

/** Test double. Honours expiry so a TTL test is a real test. */
export class InMemoryRequestCache implements RequestCache {
  private readonly entries = new Map<string, RequestCacheEntry>()
  /** Every key ever written, in order — lets a test assert write-before-processing. */
  readonly writes: string[] = []

  constructor(private readonly now: () => Date = () => new Date()) {}

  async read(cacheKey: string): Promise<RequestCacheEntry | undefined> {
    const entry = this.entries.get(cacheKey)
    if (!entry) return undefined
    if (entry.expiresAt.getTime() <= this.now().getTime()) {
      this.entries.delete(cacheKey)
      return undefined
    }
    return entry
  }

  async writeBeforeProcessing(entry: RequestCacheEntry): Promise<void> {
    this.entries.set(entry.cacheKey, entry)
    this.writes.push(entry.cacheKey)
  }

  get size(): number {
    return this.entries.size
  }
}

/** A cache that never hits. For calls that cost nothing to repeat. */
export class NullRequestCache implements RequestCache {
  async read(): Promise<undefined> {
    return undefined
  }
  async writeBeforeProcessing(): Promise<void> {}
}
