/**
 * A calendar and an article library that remember what was done to them, for
 * the browser flows that drive the Content screens.
 *
 * The frozen response fixtures cannot serve these flows for two reasons. They
 * are fixed in February 2026, and half of what the calendar does depends on
 * which side of *today* a day falls on — a day that has passed carries an
 * outcome, a day still ahead carries a plan, and only one of them can be
 * dragged onto. And they are answers rather than a system: vetoing a topic and
 * then finding it gone is the whole assertion, and a static fixture answers the
 * second read exactly as it answered the first.
 *
 * So this holds a small amount of state for the length of one run, anchored to
 * the day the run happens on. Everything else about the site still comes from
 * the frozen fixtures — this replaces the calendar and article routes only.
 *
 * The opportunities routes are the same shape of problem for a different pair
 * of screens: scheduling a CREATE has to put a topic on this same calendar, and
 * generating an OPTIMIZE recommendation has to be something a second read can
 * see finished. Both live here too, so a browser flow can move an opportunity
 * onto the calendar and then look at the calendar and find it.
 */

import {
  fixtureCreateOpportunity,
  fixtureOpportunity,
  type Opportunity,
} from '@sortiva/core'

const DAY_MS = 86_400_000

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function offset(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10)
}

export interface E2ETopic {
  id: string
  title: string
  scheduledFor: string
  state: string
  intentClass: string
  kind: string
  source: string
  pinned: boolean
  targetKeyword: string | null
  monthlySearchVolume: number | null
  why: { templateKey: string; params: Record<string, string | number> }
  opportunityId: string | null
  signalType: string | null
  articleId: string | null
  rejection: { gate: string; reason: { templateKey: string; params: Record<string, string | number> } } | null
}

const why = (volume: number) => ({
  templateKey: 'uncovered_commercial_query.no_suitable_url',
  params: { volume },
})

function seedTopics(): E2ETopic[] {
  return [
    {
      id: 'aaaaaaaa-0001-4000-8000-000000000001',
      title: 'Waterproof versus quick-drying uppers',
      scheduledFor: offset(-2),
      state: 'published',
      intentClass: 'comparison',
      kind: 'new',
      source: 'auto',
      pinned: false,
      targetKeyword: 'waterproof trail shoes',
      monthlySearchVolume: 1300,
      why: why(1300),
      opportunityId: null,
      signalType: null,
      articleId: '66666666-6666-4666-8666-666666666666',
      rejection: null,
    },
    {
      id: 'aaaaaaaa-0002-4000-8000-000000000002',
      title: 'Best trail shoes under eighty pounds',
      scheduledFor: offset(-1),
      state: 'rejected_by_gate',
      intentClass: 'buying_guide',
      kind: 'new',
      source: 'auto',
      pinned: false,
      targetKeyword: 'cheap trail shoes',
      monthlySearchVolume: 480,
      why: why(480),
      opportunityId: null,
      signalType: null,
      articleId: '77777777-0000-4000-8000-000000000009',
      rejection: {
        gate: 'gate_3',
        reason: { templateKey: 'quality_rejection.insufficient_richness', params: {} },
      },
    },
    {
      id: 'aaaaaaaa-0003-4000-8000-000000000003',
      title: 'Wide-fit shoes for wet fells',
      scheduledFor: today(),
      state: 'generating',
      intentClass: 'buying_guide',
      kind: 'new',
      source: 'auto',
      pinned: false,
      targetKeyword: 'wide fit trail running shoes',
      monthlySearchVolume: 1900,
      why: why(1900),
      opportunityId: '11111111-1111-4111-8111-111111111111',
      signalType: 'uncovered_commercial_query',
      articleId: null,
      rejection: null,
    },
    {
      id: 'aaaaaaaa-0004-4000-8000-000000000004',
      title: 'Comparing our three fell lines',
      scheduledFor: offset(1),
      state: 'planned',
      intentClass: 'comparison',
      kind: 'new',
      source: 'auto',
      pinned: false,
      targetKeyword: 'fell running shoes compared',
      monthlySearchVolume: 720,
      why: why(720),
      opportunityId: '22222222-2222-4222-8222-222222222222',
      signalType: 'uncovered_commercial_query',
      articleId: null,
      rejection: null,
    },
    {
      id: 'aaaaaaaa-0005-4000-8000-000000000005',
      title: 'Autumn ultra pack list',
      scheduledFor: offset(2),
      state: 'planned',
      intentClass: 'informational',
      kind: 'new',
      source: 'manual',
      pinned: true,
      targetKeyword: null,
      monthlySearchVolume: null,
      why: why(0),
      opportunityId: null,
      signalType: null,
      articleId: null,
      rejection: null,
    },
    {
      id: 'aaaaaaaa-0006-4000-8000-000000000006',
      title: 'Lug depth guide, updated',
      scheduledFor: offset(4),
      state: 'planned',
      intentClass: 'how_to',
      kind: 'refresh',
      source: 'auto',
      pinned: false,
      targetKeyword: 'lug depth trail shoes',
      monthlySearchVolume: 210,
      why: why(210),
      opportunityId: '33333333-3333-4333-8333-333333333333',
      signalType: 'decay',
      articleId: null,
      rejection: null,
    },
  ]
}

/**
 * Days deliberately left with nothing on them, on both sides of today: the
 * flows assert that the one behind renders as nothing at all and the one ahead
 * renders as an opening.
 */
export const GAP_BEHIND = -3
export const GAP_AHEAD = 6

// ── Opportunities ──────────────────────────────────────────────────────────

/** The day a scheduled CREATE lands on. Free in every seeded calendar above. */
const SCHEDULED_TOPIC_OFFSET = 3

interface RecommendationField {
  readonly field: string
  readonly current: string | null
  readonly suggested: string
  readonly evidence: string | null
}

interface OpportunityTask {
  id: string
  label: string
  state: 'open' | 'applied' | 'skipped'
}

interface OpportunityOverlay {
  scheduledFor: string | null
  recommendation: { state: 'none' | 'generating' | 'ready'; fields: RecommendationField[] }
  tasks: OpportunityTask[]
}

/** The two opportunities the browser flows exercise: one OPTIMIZE, one CREATE. */
const OPPORTUNITY_SOURCES: readonly Opportunity[] = [fixtureOpportunity, fixtureCreateOpportunity]

function seedOpportunityOverlays(): Map<string, OpportunityOverlay> {
  return new Map(
    OPPORTUNITY_SOURCES.map((source) => [
      source.id,
      {
        scheduledFor: null,
        recommendation: { state: 'none', fields: [] },
        tasks:
          source.recommendedAction === 'OPTIMIZE'
            ? [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', label: 'Rewrite the collection title', state: 'open' }]
            : [],
      },
    ]),
  )
}

export class ContentState {
  topics: E2ETopic[] = seedTopics()
  /** Every write the screens made, so a flow can assert on what was actually sent. */
  calls: string[] = []
  /** Per-opportunity state a static fixture cannot carry: has it been scheduled, generated, applied. */
  opportunities: Map<string, OpportunityOverlay> = seedOpportunityOverlays()

  /**
   * Back to the beginning. Every flow here changes the calendar, so without
   * this the second flow inherits the first one's decisions — and the suite
   * would pass or fail by the order it happened to run in.
   */
  reset() {
    this.topics = seedTopics()
    this.calls = []
    this.opportunities = seedOpportunityOverlays()
  }

  calendar() {
    return {
      topics: this.topics,
      paused: { active: false, reason: null },
      nextReplenishmentAt: offset(60),
    }
  }

  veto(id: string) {
    this.calls.push(`veto ${id}`)
    const topic = this.topics.find((entry) => entry.id === id)
    if (!topic) return { status: 404 as const, body: { error: { code: 'not_found', message: 'gone' } } }
    if (topic.state === 'published') {
      return {
        status: 409 as const,
        body: { error: { code: 'topic_already_published', message: 'already out' } },
      }
    }
    this.topics = this.topics.filter((entry) => entry.id !== id)
    return { status: 200 as const, body: { ok: true } }
  }

  move(id: string, date: string) {
    this.calls.push(`move ${id} ${date}`)
    const topic = this.topics.find((entry) => entry.id === id)
    if (!topic) return { status: 404 as const, body: { error: { code: 'not_found', message: 'gone' } } }
    if (topic.pinned) {
      return { status: 409 as const, body: { error: { code: 'topic_pinned', message: 'pinned' } } }
    }
    topic.scheduledFor = date
    return { status: 200 as const, body: topic }
  }

  pin(id: string, pinned: boolean) {
    this.calls.push(`pin ${id} ${pinned}`)
    const topic = this.topics.find((entry) => entry.id === id)
    if (!topic) return { status: 404 as const, body: { error: { code: 'not_found', message: 'gone' } } }
    topic.pinned = pinned
    return { status: 200 as const, body: topic }
  }

  /**
   * The admission gate, answering by what the merchant typed. A real gate looks
   * at demand and at the store; this one looks for a word, so one flow can walk
   * through all four answers it has to render.
   */
  add(input: { title: string; date: string; pin?: boolean }) {
    this.calls.push(`add ${input.title}`)
    const title = input.title.toLowerCase()

    if (this.topics.some((entry) => entry.scheduledFor === input.date)) {
      return {
        status: 409 as const,
        body: { error: { code: 'calendar_day_occupied', message: 'taken' } },
      }
    }

    if (title.includes('ranked')) {
      return {
        status: 200 as const,
        body: {
          outcome: 'converted',
          topic: null,
          warning: { templateKey: 'existing_target.prefer_optimize', params: {} },
          convertedToOpportunityId: '44444444-4444-4444-8444-444444444444',
          rejection: null,
        },
      }
    }

    if (title.includes('nonsense')) {
      return {
        status: 200 as const,
        body: {
          outcome: 'rejected',
          topic: null,
          warning: null,
          convertedToOpportunityId: null,
          rejection: {
            templateKey: 'quality_rejection.insufficient_richness',
            params: {},
          },
        },
      }
    }

    const topic: E2ETopic = {
      id: `aaaaaaaa-9999-4000-8000-${String(this.topics.length).padStart(12, '0')}`,
      title: input.title,
      scheduledFor: input.date,
      state: 'planned',
      intentClass: 'informational',
      kind: 'new',
      source: 'manual',
      pinned: input.pin ?? false,
      targetKeyword: input.title,
      monthlySearchVolume: title.includes('quiet') ? 0 : 90,
      why: why(90),
      opportunityId: null,
      signalType: null,
      articleId: null,
      rejection: null,
    }
    this.topics.push(topic)

    return {
      status: 200 as const,
      body: title.includes('quiet')
        ? {
            outcome: 'planned_with_warning',
            topic,
            warning: { templateKey: 'catalog_richness_gap.insufficient_substance', params: { products: 9 } },
            convertedToOpportunityId: null,
            rejection: null,
          }
        : {
            outcome: 'planned',
            topic,
            warning: null,
            convertedToOpportunityId: null,
            rejection: null,
          },
    }
  }

  dismissOpportunity(id: string) {
    this.calls.push(`dismiss ${id}`)
    return { status: 200 as const, body: { ok: true } }
  }

  /** The list row: the fixture's static facts plus whatever this run did to it. */
  private opportunityRow(source: Opportunity) {
    const overlay = this.opportunities.get(source.id)
    return {
      id: source.id,
      signalType: source.signalType,
      entityRef: source.entityRef,
      recommendedAction: source.recommendedAction,
      status: overlay?.scheduledFor ? 'scheduled' : source.status,
      impact: source.impact,
      impactScore: source.impactScore,
      confidence: source.confidence,
      confidenceScore: source.confidenceScore,
      confidenceFactors: [
        { label: 'Search Console data', direction: 'up' as const },
        { label: '28-day window', direction: 'up' as const },
      ],
      evidence: source.evidence,
      why: { templateKey: source.reasonTemplateKey, params: source.reasonParams },
      preconditions: source.preconditions.map((code) => ({
        code,
        whatToDo: { templateKey: `precondition.${code}`, params: { products: 6 } },
      })),
      rulesVersion: source.rulesVersion,
      limitedIntelligence: source.limitedIntelligence,
      detectedAt: source.detectedAt,
      scheduledFor: overlay?.scheduledFor ?? null,
      expiresAt: null,
    }
  }

  opportunitiesList() {
    const rows = OPPORTUNITY_SOURCES.map((source) => this.opportunityRow(source))
    return {
      opportunities: rows,
      counts: {
        open: rows.length,
        byAction: { CREATE: 1, OPTIMIZE: 1, REFRESH: 0, FIX: 0, HOLD: 0 },
      },
      lastScanAt: new Date().toISOString(),
      nextScanAt: offset(7),
      limitedIntelligence: false,
      cursor: null,
    }
  }

  opportunityDetail(id: string) {
    const source = OPPORTUNITY_SOURCES.find((entry) => entry.id === id)
    const overlay = this.opportunities.get(id)
    if (!source || !overlay) return null
    return {
      opportunity: this.opportunityRow(source),
      tasks: overlay.tasks,
      serpSnapshot: [
        { position: 1, domain: 'competitor.example', url: 'https://competitor.example/collections/trail' },
      ],
      recommendation:
        source.recommendedAction === 'OPTIMIZE'
          ? {
              state: overlay.recommendation.state,
              fields: overlay.recommendation.fields,
              internalLinksIn: [],
              internalLinksOut: [],
              intentNote:
                overlay.recommendation.state === 'ready'
                  ? 'Buyers searching this term are comparing width before price.'
                  : null,
              failureReason: null,
            }
          : null,
      history: [{ at: source.detectedAt, from: null, to: 'new', actor: 'autopilot', reason: null }],
      outcome: null,
    }
  }

  scheduleOpportunity(id: string) {
    this.calls.push(`schedule ${id}`)
    const source = OPPORTUNITY_SOURCES.find((entry) => entry.id === id)
    const overlay = this.opportunities.get(id)
    if (!source || !overlay) {
      return { status: 404 as const, body: { error: { code: 'not_found', message: 'gone' } } }
    }
    if (overlay.scheduledFor) {
      return {
        status: 409 as const,
        body: { error: { code: 'opportunity_not_open', message: 'already scheduled' } },
      }
    }
    const scheduledFor = offset(SCHEDULED_TOPIC_OFFSET)
    overlay.scheduledFor = scheduledFor
    // The calendar takes at most one topic a day, so the day handed back is
    // the product's own answer — this is the same route the CREATE/REFRESH
    // autopilot policy schedules through, "Schedule" only pulls it forward.
    this.topics.push({
      id: `bbbbbbbb-0000-4000-8000-${id.slice(-12)}`,
      title: source.entityRef.label,
      scheduledFor,
      state: 'planned',
      intentClass: 'buying_guide',
      kind: 'new',
      source: 'auto',
      pinned: false,
      targetKeyword: null,
      monthlySearchVolume: null,
      why: { templateKey: source.reasonTemplateKey, params: source.reasonParams },
      opportunityId: id,
      signalType: source.signalType,
      articleId: null,
      rejection: null,
    })
    return { status: 200 as const, body: { topicId: `bbbbbbbb-0000-4000-8000-${id.slice(-12)}`, scheduledFor } }
  }

  /** Fills in a recommendation as though generation had just finished. */
  generateRecommendation(id: string) {
    this.calls.push(`generate ${id}`)
    const overlay = this.opportunities.get(id)
    if (!overlay) return { status: 404 as const, body: { error: { code: 'not_found', message: 'gone' } } }
    overlay.recommendation = {
      state: 'ready',
      fields: [
        {
          field: 'title',
          current: 'Trail running shoes',
          suggested: 'Trail running shoes for wide feet',
          evidence: '3 of the top 5 results cover width explicitly',
        },
        {
          field: 'metaDescription',
          current: null,
          suggested: 'Wide-fit trail running shoes that do not pinch at the toe box.',
          evidence: null,
        },
      ],
    }
    return { status: 200 as const, body: { ok: true } }
  }

  markOpportunityTask(id: string, taskId: string, state: 'applied' | 'skipped') {
    this.calls.push(`opportunity-task ${id} ${taskId} ${state}`)
    const task = this.opportunities.get(id)?.tasks.find((entry) => entry.id === taskId)
    if (!task) return { status: 404 as const, body: { error: { code: 'not_found', message: 'gone' } } }
    task.state = state
    return { status: 200 as const, body: { ok: true } }
  }
}

// ── Articles ────────────────────────────────────────────────────────────────

/** The held draft: the state that carries the quality report and the override. */
export const HELD_ARTICLE_ID = '77777777-0000-4000-8000-000000000009'
/** An exported article nobody has told us the address of. */
export const EXPORTED_ARTICLE_ID = '88888888-0000-4000-8000-000000000008'
/** A draft that cleared the quality bar and is waiting on a human's approve/discard. */
export const IN_REVIEW_ARTICLE_ID = '99999999-0000-4000-8000-000000000007'

export function articlesList() {
  return {
    articles: [
      {
        id: HELD_ARTICLE_ID,
        title: 'Best trail shoes under eighty pounds',
        state: 'rejected',
        delivery: 'auto',
        publishedAt: null,
        publishedUrl: null,
        publishedViaOverride: false,
        repaired: false,
        refreshedCount: 0,
        performance: null,
      },
      {
        id: EXPORTED_ARTICLE_ID,
        title: 'Winter fell kit: the full list',
        state: 'published',
        delivery: 'export',
        publishedAt: new Date(Date.now() - 3 * DAY_MS).toISOString(),
        publishedUrl: null,
        publishedViaOverride: false,
        repaired: false,
        refreshedCount: 0,
        performance: null,
      },
      {
        id: IN_REVIEW_ARTICLE_ID,
        title: 'Choosing a drop height for fell running',
        state: 'in_review',
        delivery: 'auto',
        publishedAt: null,
        publishedUrl: null,
        publishedViaOverride: false,
        repaired: false,
        refreshedCount: 0,
        performance: null,
      },
    ],
    cursor: null,
  }
}

export function articleDetail(id: string) {
  const summary = articlesList().articles.find((article) => article.id === id)
  if (!summary) return null
  return {
    article: summary,
    html: '<h1>' + summary.title + '</h1><p>Under eighty pounds you are mostly choosing between last season and entry level.</p>',
    metadata: {
      targetKeyword: 'trail shoes under 80',
      slug: 'best-trail-shoes-under-80',
      metaDescription: 'What you give up at this price, and where it matters.',
      familyIds: ['trail-running'],
      opportunityId: '11111111-1111-4111-8111-111111111111',
    },
    evidencePack: [{ productId: 'trail-running-1', title: 'Trail Running 1' }],
    qualityReport:
      id === HELD_ARTICLE_ID
        ? {
            scores: { informationGain: 2, factualGrounding: 5, structure: 4 },
            justifications: {
              informationGain:
                'The comparison repeats specifications available on every competing page.',
            },
            promptVersion: 'judge.v1',
            modelId: 'claude-sonnet-5',
            passed: false,
          }
        : id === IN_REVIEW_ARTICLE_ID
          ? {
              scores: { informationGain: 4, factualGrounding: 4, structure: 4 },
              justifications: {},
              promptVersion: 'judge.v1',
              modelId: 'claude-sonnet-5',
              passed: true,
            }
          : null,
    history: [{ at: new Date(Date.now() - DAY_MS).toISOString(), event: 'generated' }],
  }
}
