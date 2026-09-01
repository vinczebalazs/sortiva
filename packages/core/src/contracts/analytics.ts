/**
 * Everything observable is an analytics event captured server-side. Two rules
 * are structural here rather than conventions a call site can forget:
 *
 * 1. **Everything is groupable by domain.** Every event carries the `domain`
 *    group, keyed on `domain_normalized` — because "how much is site X costing
 *    us" must be one insight.
 * 2. **Preview attribution is a property, not a group.** The domain group is
 *    reserved for *claimed* domains; ten strangers previewing `nike.com` is not
 *    Nike-the-account costing us money. Preview events carry `target_domain` as
 *    a plain property instead.
 *
 * `EventAttribution` is a union of exactly those two cases, so a preview event
 * cannot acquire a domain group by accident — there is no field for it.
 */

export type EventAttribution =
  | {
      readonly kind: 'account'
      readonly accountId: string
      /** The normalised domain. Absent until the account has claimed one. */
      readonly domain?: string
    }
  | {
      readonly kind: 'preview'
      /** The domain the visitor asked about. A property only, never a group: ten strangers previewing `nike.com` is not Nike costing us money. */
      readonly targetDomain: string
      /**
       * The registrable domain behind `targetDomain` — what a merchant claims at
       * signup. Spend is recorded against this so a visitor who previews
       * `shop.example.com` and later claims `example.com` has that spend join to
       * their account. The exact host stays on the
       * event property, where it is what you want for spotting abuse.
       */
      readonly billableDomain: string
    }

export function accountAttribution(accountId: string, domain?: string): EventAttribution {
  return domain === undefined ? { kind: 'account', accountId } : { kind: 'account', accountId, domain }
}

export function previewAttribution(
  targetDomain: string,
  billableDomain: string = targetDomain,
): EventAttribution {
  return { kind: 'preview', targetDomain, billableDomain }
}

/** The analytics group type. Keyed on the normalised domain, so "what is site X costing us" is answerable. */
export const DOMAIN_GROUP = 'domain'

export interface ResolvedAttribution {
  /** PostHog `distinctId`. Preview traffic is anonymous, so it is keyed by target domain. */
  distinctId: string
  groups: Record<string, string>
  properties: Record<string, unknown>
}

/**
 * The one place the two rules above are applied. Both the live wrapper and the
 * test double call it, so a test asserting the preview rule is asserting the
 * production path.
 */
export function resolveAttribution(attribution: EventAttribution): ResolvedAttribution {
  if (attribution.kind === 'preview') {
    return {
      distinctId: `preview:${attribution.targetDomain}`,
      groups: {},
      properties: { target_domain: attribution.targetDomain },
    }
  }
  return {
    distinctId: attribution.accountId,
    groups: attribution.domain ? { [DOMAIN_GROUP]: attribution.domain } : {},
    properties: { account_id: attribution.accountId },
  }
}

export interface AnalyticsEvent {
  /** snake_case, one event per lifecycle moment. */
  readonly event: string
  readonly attribution: EventAttribution
  /** Ids and aggregates only — never product content, article text, or prompts. */
  readonly properties?: Record<string, unknown>
}

/** The `$ai_generation` capture the LLM wrapper emits on every call. */
export interface AiGenerationEvent {
  readonly attribution: EventAttribution
  readonly callType: string
  readonly promptVersion: string
  readonly modelId: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly latencyMs: number
  /** Zero on a cache replay — cached work must not inflate spend numbers. */
  readonly usdCost: number
  readonly cacheHit: boolean
  readonly traceId?: string
  readonly properties?: Record<string, unknown>
}

/** The SEO data vendor is a plain HTTP API with no analytics integration of its own, so its cost is an event we emit. */
export interface SeoRequestEvent {
  readonly attribution: EventAttribution
  readonly endpoint: string
  readonly billable: boolean
  readonly cacheHit: boolean
  readonly usdCost: number
  readonly properties?: Record<string, unknown>
}

export interface PosthogCapture {
  capture(event: AnalyticsEvent): void
  captureAiGeneration(event: AiGenerationEvent): void
  captureSeoRequest(event: SeoRequestEvent): void
  /** Captures an exception with the same attribution. Scrubbed of secrets before it leaves the process. */
  captureException(error: unknown, attribution: EventAttribution, properties?: Record<string, unknown>): void
  flush(): Promise<void>
  shutdown(): Promise<void>
}
