import type {
  CatalogEvent,
  EvidenceFact,
  JudgeVerdict,
  Opportunity,
  QueryCluster,
  ScheduledTopic,
} from './opportunities'

/**
 * Fixture data for the build-plan §4 seams: one realistic example per contract,
 * shared by the doubles, the MSW handlers and the API schema tests, so all three
 * describe the same product rather than three plausible inventions.
 *
 * The numbers are main §7.8's own — scenario 1's striking-distance case — so a
 * fixture and an acceptance fixture tell the same story.
 */

export const FIXTURE_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'
export const FIXTURE_DOMAIN = 'example-outdoor.com'
export const FIXTURE_RULES_VERSION = 'a'.repeat(64)

export const fixtureEvidence: readonly EvidenceFact[] = [
  {
    key: 'impressions',
    value: 9402,
    source: 'gsc',
    window: '28d',
    fetchedAt: '2026-02-01T03:00:00.000Z',
  },
  {
    key: 'average_position',
    value: 7.3,
    source: 'gsc',
    window: '28d',
    fetchedAt: '2026-02-01T03:00:00.000Z',
  },
  {
    key: 'matching_products',
    value: 14,
    source: 'catalog',
    fetchedAt: '2026-02-01T02:30:00.000Z',
  },
]

export const fixtureOpportunity: Opportunity = {
  id: '22222222-2222-4222-8222-222222222222',
  accountId: FIXTURE_ACCOUNT_ID,
  signalType: 'striking_distance',
  entityRef: {
    kind: 'page',
    id: '/collections/trail-running',
    label: 'Collection: Trail running shoes',
  },
  recommendedAction: 'OPTIMIZE',
  status: 'new',
  impactScore: 78,
  impact: 'high',
  confidenceScore: 0.72,
  confidence: 'high',
  evidence: fixtureEvidence,
  reasonTemplateKey: 'striking_distance.page_one_intent_mismatch',
  reasonParams: { position: 7.3, impressions: 9402 },
  preconditions: [],
  rulesVersion: FIXTURE_RULES_VERSION,
  limitedIntelligence: false,
  detectedAt: '2026-02-02T06:00:00.000Z',
}

/** A CREATE opportunity, so the replenishment consumer has something to schedule. */
export const fixtureCreateOpportunity: Opportunity = {
  ...fixtureOpportunity,
  id: '33333333-3333-4333-8333-333333333333',
  signalType: 'uncovered_commercial_query',
  entityRef: {
    kind: 'query_cluster',
    id: 'trail-running-shoes-wide-feet',
    label: '"trail running shoes for wide feet"',
  },
  recommendedAction: 'CREATE',
  status: 'accepted',
  impactScore: 64,
  impact: 'medium',
  reasonTemplateKey: 'uncovered_commercial_query.no_suitable_url',
  reasonParams: { volume: 880 },
}

/** A HOLD, so the blocked-precondition rendering path has a fixture (main §7.4, ui §5.2). */
export const fixtureHoldOpportunity: Opportunity = {
  ...fixtureOpportunity,
  id: '44444444-4444-4444-8444-444444444444',
  signalType: 'catalog_richness_gap',
  entityRef: { kind: 'family', id: 'trail-running', label: 'Family: Trail running shoes' },
  recommendedAction: 'HOLD',
  status: 'blocked',
  impact: 'high',
  preconditions: ['missing_product_details'],
  reasonTemplateKey: 'catalog_richness_gap.insufficient_substance',
  reasonParams: { products: 6 },
}

export const fixtureOpportunities: readonly Opportunity[] = [
  fixtureOpportunity,
  fixtureCreateOpportunity,
  fixtureHoldOpportunity,
]

export const fixtureQueryCluster: QueryCluster = {
  head: 'trail running shoes for wide feet',
  members: ['wide trail running shoes', 'best trail shoes wide toe box'],
  intentClass: 'buying_guide',
  familyIds: ['trail-running'],
}

export const fixtureScheduledTopic: ScheduledTopic = {
  topicId: '55555555-5555-4555-8555-555555555555',
  opportunityId: fixtureCreateOpportunity.id,
  scheduledFor: '2026-02-14',
  title: 'Best trail running shoes for wide feet',
  state: 'planned',
}

/**
 * A passing verdict with the floors main §8.4 sets: information gain and
 * grounding at 4, the rest at 3. Invariant 11 gates on the minimum, never the
 * average — a fixture that scored 5s everywhere would let a consumer's test
 * pass without ever exercising the floor.
 */
export const fixtureJudgeVerdict: JudgeVerdict = {
  passed: true,
  scores: {
    informationGain: 4,
    factualGrounding: 4,
    structure: 3,
    readability: 3,
    intentMatch: 3,
  },
  justifications: {
    informationGain: 'Adds width-specific fit guidance the top results do not cover.',
    factualGrounding: 'Every product claim resolves to a distilled catalog fact.',
  },
  promptVersion: 'judge.v1',
  modelId: 'claude-sonnet-5',
}

export const fixtureCatalogEvents: readonly CatalogEvent[] = [
  {
    accountId: FIXTURE_ACCOUNT_ID,
    kind: 'product_updated',
    entityId: 'trail-running-3',
    occurredAt: '2026-02-02T09:12:00.000Z',
    changedFields: ['body_html', 'price'],
  },
  {
    accountId: FIXTURE_ACCOUNT_ID,
    kind: 'availability_changed',
    entityId: 'trail-running-7',
    occurredAt: '2026-02-02T09:14:00.000Z',
    changedFields: ['available'],
  },
]
