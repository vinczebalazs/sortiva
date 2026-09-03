/**
 * A store being set up, for the browser flow that walks the whole of onboarding
 * in one run: no domain, to the Shopify grant, through the seven-row progress
 * list, to confirming the profile, to the first scan landing on Opportunities.
 *
 * The dashboard route decides what is on screen entirely from `GET /api/account`
 * and `GET /api/ingestion/status` (`resolveOnboardingSurface` in
 * `packages/ui/src/onboarding/surface.ts`), so driving those two answers through
 * one run's worth of state — rather than serving them as fixed bodies — is what
 * lets a real browser walk the real screens through every stage rather than
 * only rendering one of them at a time.
 *
 * Two stages block on a person, the same way the product itself blocks: the
 * Shopify grant and the Search Console step. Nothing else does — the steps
 * between them advance on their own, the way a real ingestion run would, so the
 * stepper has something true to show while a test waits on it.
 */

const DAY_MS = 86_400_000

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

export type DomainState =
  | 'none'
  | 'awaiting_shopify_auth'
  | 'ingesting'
  | 'needs_confirmation'
  | 'ready_for_planning'

export type JobStepState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'skipped'

interface JobStep {
  readonly step: string
  readonly state: JobStepState
  readonly startedAt: string | null
  readonly updatedAt: string
  readonly attempts: number
}

/** How long, from the Shopify grant, before each automatic step finishes. */
const AUTO_STEP_OFFSETS_MS: readonly [string, number][] = [
  ['catalog_sync', 400],
  ['distill', 800],
  ['family_group', 1100],
  ['persona', 1400],
  ['keywords_competitors', 1700],
]

export class OnboardingState {
  domain: { normalized: string; state: DomainState; platform: string } | null = null
  shopify: 'none' | 'read' | 'broken' = 'none'
  searchConsole: 'none' | 'connected' = 'none'
  lastScanAt: string | null = null
  /**
   * Whether the onboarding routes answer from this state at all.
   *
   * `domain === null` is not enough to tell "nobody has claimed a domain yet"
   * apart from "this run has nothing to do with onboarding" — every other
   * browser flow's `GET /api/account` needs the ordinary, already-set-up
   * account the frozen fixtures describe, not a merchant on their first day.
   * Only the onboarding spec ever calls `begin()`.
   */
  active = false
  /** When the Shopify grant landed; every automatic step is timed from here. */
  private shopifyGrantedAt: number | null = null
  /**
   * Set once the merchant has resolved the Search Console step. The flow this
   * harness drives only ever skips it — GSC's own OAuth round trip and
   * property picker are exercised by `SearchConsoleStep`'s own component
   * tests, and re-simulating a second vendor's OAuth here would add a second
   * `window.location.assign` redirect trick for no new coverage.
   */
  private gscSettled = false
  /** Set once the profile is confirmed; the first scan "finishes" a moment later. */
  private confirmedAt: number | null = null

  reset(): void {
    this.active = false
    this.domain = null
    this.shopify = 'none'
    this.searchConsole = 'none'
    this.lastScanAt = null
    this.shopifyGrantedAt = null
    this.gscSettled = false
    this.confirmedAt = null
  }

  /** Starts a fresh run: a merchant who has just signed up, with no domain yet. */
  begin(): void {
    this.reset()
    this.active = true
  }

  account() {
    return {
      accountId: '22222222-4444-4444-8444-222222222222',
      email: 'merchant@example.com',
      domain: this.domain,
      subscription: { status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: iso(30 * DAY_MS) },
      // True only once GSC has been asked and declined — the same fact the
      // Limited Intelligence badge reads everywhere else.
      limitedIntelligence: this.gscSettled,
      connections: { shopify: this.shopify, searchConsole: this.searchConsole, lastScanAt: this.lastScanAt },
      servicePaused: false,
    }
  }

  claim(domain: string): { status: 200 | 422; body: unknown } {
    const trimmed = domain.trim().toLowerCase()
    if (trimmed.length === 0) return { status: 422, body: { error: { code: 'invalid', message: 'empty' } } }
    this.domain = { normalized: trimmed, state: 'awaiting_shopify_auth', platform: 'shopify' }
    return { status: 200, body: { ok: true } }
  }

  /** The read-only grant lands: the clock the automatic steps run against starts here. */
  connectShopify(): void {
    if (!this.domain) return
    this.shopify = 'read'
    this.domain = { ...this.domain, state: 'ingesting' }
    this.shopifyGrantedAt = Date.now()
  }

  skipSearchConsole(): void {
    this.gscSettled = true
    if (!this.domain) return
    this.domain = { ...this.domain, state: 'needs_confirmation' }
  }

  confirmProfile(): void {
    if (!this.domain) return
    this.domain = { ...this.domain, state: 'ready_for_planning' }
    this.confirmedAt = Date.now()
  }

  /**
   * True while the wait card should still see nothing. `GET /api/opportunities`
   * reads this to decide whether to answer empty or hand back the real list —
   * the same fact `scanProduced()` in
   * `packages/ui/src/onboarding/FindingOpportunities.tsx` looks for, which is
   * what ends the wait and sends the merchant on to Opportunities.
   */
  awaitingFirstScan(): boolean {
    if (this.confirmedAt === null) return false
    if (Date.now() - this.confirmedAt < 1500) return true
    if (this.lastScanAt === null) this.lastScanAt = iso()
    return false
  }

  /** True once GSC has been declined — the same fact `account()` reports as `limitedIntelligence`. */
  hasLimitedIntelligence(): boolean {
    return this.gscSettled
  }

  /** The confirmation screen's draft: everything ingestion is said to have worked out. */
  profileDraft() {
    return {
      description: 'A specialist retailer of fell and trail running footwear.',
      language: 'en',
      country: 'GB',
      audience: 'Fell and trail runners',
      tone: 'Practical, technical, no hype',
      topProducts: [
        {
          id: 'e2e-product-1',
          title: 'Fell Runner Low',
          imageUrl: null,
          source: 'orders_api',
          pinned: false,
          revenueBand: 'high',
        },
      ],
      keywords: [
        {
          id: 'e2e-keyword-1',
          term: 'fell running shoes',
          monthlySearchVolume: 720,
          difficulty: 28,
          source: 'auto',
          enrichmentState: 'enriched',
        },
      ],
      competitors: [{ id: 'e2e-competitor-1', domain: 'competitor.example', source: 'auto' }],
      competitorSuggestions: [{ domain: 'suggested.example', appearsInQueries: 6 }],
      families: [
        {
          id: 'fell-running',
          label: 'Fell Running',
          memberCount: 9,
          axes: ['terrain', 'drop'],
          groupingSource: 'fact_clustering',
          lowConfidence: false,
        },
      ],
      richness: { band: 'okay' as const, productsMissingDetails: 4 },
      searchConsole: { connected: false, property: null },
      confirmed: false,
    }
  }

  /** The ingestion run's steps, computed from wall-clock time since the grant. */
  ingestionStatus(): { jobId: string; status: string; startedAt: string; steps: JobStep[] } | null {
    if (!this.domain || this.shopifyGrantedAt === null) {
      // Still waiting on the grant itself: only `detect` and the wait step exist.
      if (!this.domain) return null
      return {
        jobId: 'e2e-onboarding-run',
        status: 'running',
        startedAt: iso(),
        steps: [
          this.row('detect', 'succeeded', 0),
          this.row('oauth_wait', 'running', 0),
        ],
      }
    }

    const elapsed = Date.now() - this.shopifyGrantedAt
    const steps: JobStep[] = [this.row('detect', 'succeeded', -1), this.row('oauth_wait', 'succeeded', 0)]

    let allAutoDone = true
    let previousOffset = 0
    for (const [name, atMs] of AUTO_STEP_OFFSETS_MS) {
      if (elapsed >= atMs) {
        steps.push(this.row(name, 'succeeded', atMs))
      } else if (elapsed >= previousOffset) {
        steps.push(this.row(name, 'running', previousOffset))
        allAutoDone = false
      } else {
        steps.push(this.row(name, 'pending', null))
        allAutoDone = false
      }
      previousOffset = atMs
    }

    if (!allAutoDone) {
      return { jobId: 'e2e-onboarding-run', status: 'running', startedAt: iso(-elapsed), steps }
    }

    // Every automatic step is in. Search Console waits on the merchant, exactly
    // as the Shopify grant did.
    if (!this.gscSettled) {
      steps.push(this.row('gsc_connect', 'running', AUTO_STEP_OFFSETS_MS.at(-1)![1]))
      steps.push(this.row('awaiting_confirmation', 'pending', null))
      return { jobId: 'e2e-onboarding-run', status: 'running', startedAt: iso(-elapsed), steps }
    }

    steps.push(this.row('gsc_connect', 'skipped', AUTO_STEP_OFFSETS_MS.at(-1)![1]))
    steps.push(this.row('awaiting_confirmation', 'running', AUTO_STEP_OFFSETS_MS.at(-1)![1]))
    return { jobId: 'e2e-onboarding-run', status: 'running', startedAt: iso(-elapsed), steps }
  }

  private row(step: string, state: JobStepState, startedOffsetMs: number | null): JobStep {
    return {
      step,
      state,
      startedAt: startedOffsetMs === null ? null : iso(-Math.max(0, startedOffsetMs)),
      updatedAt: iso(),
      attempts: state === 'pending' ? 0 : 1,
    }
  }
}
