/**
 * main §14.7 — everything observable is a PostHog event captured server-side.
 * Two rules from that section are structural here rather than conventions a
 * call site can forget:
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
      /** `domain_normalized`. Absent before the account claims a domain (main §5). */
      readonly domain?: string
    }
  | {
      readonly kind: 'preview'
      /** The domain the visitor asked about. Property only, never a group (main §14.7). */
      readonly targetDomain: string
    }

export function accountAttribution(accountId: string, domain?: string): EventAttribution {
  return domain === undefined ? { kind: 'account', accountId } : { kind: 'account', accountId, domain }
}

export function previewAttribution(targetDomain: string): EventAttribution {
  return { kind: 'preview', targetDomain }
}

/** PostHog group type name. main §14.7: "group key = domain_normalized". */
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
  /** snake_case, one event per lifecycle moment (main §14.7 taxonomy). */
  readonly event: string
  readonly attribution: EventAttribution
  /** Ids and aggregates only — never product content, article text, or prompts (main §14.7 privacy note). */
  readonly properties?: Record<string, unknown>
}

/** main §14.7 — the `$ai_generation` capture the LLM wrapper emits on every call. */
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

/** main §14.7 — DataForSEO is a plain HTTP API, so its cost is our own event. */
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
  /** Captures an exception with the same attribution. Scrubbed before it leaves (tech §4). */
  captureException(error: unknown, attribution: EventAttribution, properties?: Record<string, unknown>): void
  flush(): Promise<void>
  shutdown(): Promise<void>
}
