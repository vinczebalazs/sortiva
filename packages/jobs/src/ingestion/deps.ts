import type pg from 'pg'
import type { Db } from '@sortiva/db'
import type {
  DistillPrompt,
  LlmClient,
  NotificationEmitter,
  PersonaPrompt,
  PosthogCapture,
  ShopifyOAuthProvider,
  StoreConnection,
  StoreDomainStore,
  StorePageFetcher,
} from '@sortiva/core'

/**
 * Everything the onboarding steps reach outside themselves, in one bundle the
 * process assembles once and hands down.
 *
 * Written as ports rather than concrete clients so a step can be driven against
 * an in-memory Shopify and an in-memory page fetcher — which is what makes the
 * whole of onboarding testable without a Partner account or a live store.
 */

/** The store's own record, as read back to confirm a freshly granted token works. */
export interface ShopSnapshot {
  readonly id: number
  readonly name: string
  readonly myshopifyDomain: string
  /**
   * The shop owner's own working clock. Deliberately *not* what we publish
   * against: articles go out on the audience's clock, which comes from the
   * persona's country, so a German store run from Bali still publishes at nine
   * in Berlin.
   */
  readonly ianaTimezone: string | null
  readonly countryCode: string | null
  readonly currency: string | null
  /** The language the merchant configured the storefront in, e.g. `de-DE`. */
  readonly primaryLocale: string | null
}

export interface ShopReader {
  getShop(input: { shop: string; accessToken: string }): Promise<ShopSnapshot>
}

/**
 * Reading one page of a list the store publishes, and being told where the next
 * page starts.
 *
 * Deliberately the same client as `ShopReader` in production rather than a
 * second one: a second client would be a second set of rate-limit, retry and
 * dead-token behaviours, and only one of them would get fixed when Shopify
 * changed something.
 */
export interface ShopifyListReader {
  getPage<T>(
    input: { shop: string; accessToken: string },
    path: string,
  ): Promise<{ body: T; nextPageInfo: string | undefined }>
}

/** Reading and writing one store's connection, tokens decrypted at the edge. */
export interface ConnectionStore {
  read(accountId: string): Promise<StoreConnection | undefined>
  /** The decrypted token, for a caller about to make a call with it. */
  readToken(accountId: string): Promise<string | undefined>
  markInvalid(accountId: string, at: Date): Promise<Date>
}

export interface IngestionDeps {
  readonly db: Db
  /** Advisory locks need a connection they can hold for the length of a step. */
  readonly pool: pg.Pool
  readonly fetcher: StorePageFetcher
  readonly shopify: ShopifyOAuthProvider
  readonly shop: ShopReader
  /** Absent only in tests that drive steps which never read a list. */
  readonly admin?: ShopifyListReader
  readonly connections: ConnectionStore
  readonly domains: StoreDomainStore & {
    /** The domain this account claimed, normalised. */
    readNormalized(accountId: string): Promise<string | undefined>
  }
  /**
   * The single instrumented model client. Optional only because most steps make
   * no model call; distillation fails as a terminal error without it rather
   * than quietly producing empty fact sheets for a whole catalogue.
   */
  readonly llm?: LlmClient
  /** The versioned distillation prompt, loaded from `prompts/distill.v<N>.md` by the process. */
  readonly distillPrompt?: DistillPrompt
  /** The versioned persona prompt, loaded from `prompts/persona.v<N>.md` by the process. */
  readonly personaPrompt?: PersonaPrompt
  readonly notifications?: NotificationEmitter
  /**
   * Server-side analytics. Optional so a step runs without telemetry: a missing
   * client must never be able to fail the work it was only reporting on.
   */
  readonly capture?: Pick<PosthogCapture, 'capture'>
  readonly now?: () => Date
}
