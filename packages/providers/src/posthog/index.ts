import { PostHog } from 'posthog-node'
import {
  DOMAIN_GROUP,
  createLogger,
  resolveAttribution,
  scrub,
  type AiGenerationEvent,
  type AnalyticsEvent,
  type EventAttribution,
  type Logger,
  type PosthogCapture,
  type SeoRequestEvent,
} from '@sortiva/core'

/**
 * The server-side analytics capture wrapper. A lint rule makes this the only
 * file allowed to import `posthog-node`, so three rules hold everywhere by
 * construction rather than by review:
 *
 * - **Every event is groupable by domain** (`group key = domain_normalized`), so
 *   "how much is site X costing us" is one insight rather than a join.
 * - **Preview traffic gets a property, not a group.** The domain group is
 *   reserved for claimed domains; ten strangers previewing `nike.com` is not
 *   Nike-the-account costing us money. Enforced by `resolveAttribution`.
 * - **Nothing customer-derived leaves the process.** Properties are scrubbed
 *   before sending, so a token in a property is redacted before it reaches the
 *   wire.
 *
 * Analytics is telemetry and alerting, never the control plane: no code path
 * reads back from here to make a decision, because a kill switch has to keep
 * working when this vendor does not.
 */

/** PostHog's own AI-analytics event name, so the built-in LLM dashboards work. */
const AI_GENERATION_EVENT = '$ai_generation'

export interface PosthogServerCaptureOptions {
  apiKey?: string
  host?: string
  client?: PostHog
  /** A missing key disables capture rather than throwing — local dev has no project. */
  enabled?: boolean
  logger?: Logger
}

export class PosthogServerCapture implements PosthogCapture {
  private readonly client: PostHog | undefined

  constructor(options: PosthogServerCaptureOptions = {}) {
    if (options.client) {
      this.client = options.client
      return
    }
    const apiKey = options.apiKey ?? process.env.POSTHOG_API_KEY
    const enabled = options.enabled ?? Boolean(apiKey)
    this.client =
      enabled && apiKey
        ? new PostHog(apiKey, { host: options.host ?? process.env.POSTHOG_HOST })
        : undefined
    if (!this.client) {
      // Audit `docs/audits/T0.5.md` finding 6: without a key this wrapper
      // records nothing, with no error and no log line — so a deploy missing
      // `POSTHOG_API_KEY` spent real money invisibly. It still degrades rather
      // than throwing (local dev has no project), but it now says so once.
      // Note this only silences the *dashboards*; the spend caps read our own
      // ledger, which is a separate port and unaffected.
      ;(options.logger ?? createLogger()).warn('posthog_capture_disabled', {
        reason: apiKey ? 'explicitly disabled' : 'POSTHOG_API_KEY is not set',
      })
    }
  }

  capture(event: AnalyticsEvent): void {
    const resolved = resolveAttribution(event.attribution)
    this.client?.capture({
      distinctId: resolved.distinctId,
      event: event.event,
      properties: scrub({ ...resolved.properties, ...(event.properties ?? {}) }),
      groups: resolved.groups,
    })
  }

  captureAiGeneration(event: AiGenerationEvent): void {
    const resolved = resolveAttribution(event.attribution)
    this.client?.capture({
      distinctId: resolved.distinctId,
      event: AI_GENERATION_EVENT,
      properties: scrub(aiProperties(event, resolved.properties)),
      groups: resolved.groups,
    })
  }

  captureSeoRequest(event: SeoRequestEvent): void {
    const resolved = resolveAttribution(event.attribution)
    this.client?.capture({
      distinctId: resolved.distinctId,
      event: 'dataforseo_request',
      properties: scrub(seoProperties(event, resolved.properties)),
      groups: resolved.groups,
    })
  }

  captureException(
    error: unknown,
    attribution: EventAttribution,
    properties: Record<string, unknown> = {},
  ): void {
    const resolved = resolveAttribution(attribution)
    // The scrubber sits on the exception path too: a token in a message or a
    // stack frame is redacted before it ever leaves the process.
    this.client?.captureException(scrub(error), resolved.distinctId, {
      ...scrub({ ...resolved.properties, ...properties }),
      $groups: resolved.groups,
    })
  }

  async flush(): Promise<void> {
    await this.client?.flush()
  }

  async shutdown(): Promise<void> {
    await this.client?.shutdown()
  }
}

/** The properties we require on top of PostHog's own AI capture. */
function aiProperties(
  event: AiGenerationEvent,
  base: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...base,
    $ai_provider: 'anthropic',
    $ai_model: event.modelId,
    $ai_input_tokens: event.inputTokens,
    $ai_output_tokens: event.outputTokens,
    $ai_latency: event.latencyMs / 1000,
    $ai_total_cost_usd: event.usdCost,
    ...(event.traceId ? { $ai_trace_id: event.traceId } : {}),
    call_type: event.callType,
    prompt_version: event.promptVersion,
    cache_hit: event.cacheHit,
    ...(event.properties ?? {}),
  }
}

function seoProperties(
  event: SeoRequestEvent,
  base: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...base,
    endpoint: event.endpoint,
    billable: event.billable,
    cache_hit: event.cacheHit,
    usd_cost: event.usdCost,
    ...(event.properties ?? {}),
  }
}

export interface RecordedCapture {
  readonly event: string
  readonly distinctId: string
  readonly groups: Record<string, string>
  readonly properties: Record<string, unknown>
}

/**
 * Test double. It runs the *same* attribution and scrubbing path as the live
 * wrapper, so a test asserting "preview events carry no domain group" is
 * asserting production behaviour, not the double's.
 */
export class MockPosthogCapture implements PosthogCapture {
  readonly events: RecordedCapture[] = []
  readonly exceptions: { error: unknown; capture: RecordedCapture }[] = []

  capture(event: AnalyticsEvent): void {
    this.record(event.event, event.attribution, event.properties ?? {})
  }

  captureAiGeneration(event: AiGenerationEvent): void {
    this.record(AI_GENERATION_EVENT, event.attribution, aiProperties(event, {}))
  }

  captureSeoRequest(event: SeoRequestEvent): void {
    this.record('dataforseo_request', event.attribution, seoProperties(event, {}))
  }

  captureException(
    error: unknown,
    attribution: EventAttribution,
    properties: Record<string, unknown> = {},
  ): void {
    this.exceptions.push({
      error: scrub(error),
      capture: this.record('$exception', attribution, properties),
    })
  }

  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}

  reset(): void {
    this.events.length = 0
    this.exceptions.length = 0
  }

  of(event: string): RecordedCapture[] {
    return this.events.filter((e) => e.event === event)
  }

  /** Total LLM and SEO-data spend seen — the number the cost dashboards trend. */
  get totalUsdCost(): number {
    return this.events.reduce((total, e) => {
      const ai = typeof e.properties.$ai_total_cost_usd === 'number' ? e.properties.$ai_total_cost_usd : 0
      const seo = typeof e.properties.usd_cost === 'number' ? e.properties.usd_cost : 0
      return total + ai + seo
    }, 0)
  }

  private record(
    event: string,
    attribution: EventAttribution,
    properties: Record<string, unknown>,
  ): RecordedCapture {
    const resolved = resolveAttribution(attribution)
    const captured: RecordedCapture = {
      event,
      distinctId: resolved.distinctId,
      groups: resolved.groups,
      properties: scrub({ ...resolved.properties, ...properties }),
    }
    this.events.push(captured)
    return captured
  }
}

/**
 * **A capture that records nothing.** The counterpart of `UnrecordedSpend`:
 * both wrappers now require a recorder, so a caller that genuinely does not
 * want telemetry has to name this class (audit `docs/audits/T0.5.md` finding
 * 6). "Not recorded" is then a visible choice in the code, never what a missing
 * argument quietly produced.
 *
 * `PosthogServerCapture` with no key behaves the same way, but reaching that
 * state is a deployment mistake; reaching this one is a decision.
 */
export class UnrecordedCapture implements PosthogCapture {
  capture(_event: AnalyticsEvent): void {}
  captureAiGeneration(_event: AiGenerationEvent): void {}
  captureSeoRequest(_event: SeoRequestEvent): void {}
  captureException(
    _error: unknown,
    _attribution: EventAttribution,
    _properties?: Record<string, unknown>,
  ): void {}
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

export { DOMAIN_GROUP }
