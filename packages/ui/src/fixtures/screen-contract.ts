/**
 * Which fields of which mock response each built screen actually reads.
 *
 * Every screen in this product is built against the mock server months before
 * its backend exists. Without a record, the card that later writes the real
 * endpoint has no way to know which of the fields it declared are load-bearing
 * and which were never used — and the first time anyone finds out is when a
 * screen renders blank against the real API.
 *
 * So each screen registers its fields here as it is built, and a test asserts
 * every path still resolves in the mock fixtures. A backend card reads this and
 * inherits a contract; a field removed from a fixture fails a test in the lane
 * that depended on it.
 */

export interface ScreenFixtureDependency {
  /** The screen, by the name the design canvas and the UI spec both use. */
  readonly screen: string
  /** `METHOD /api/path`, matching the route table. */
  readonly route: string
  /** Dotted paths into the response body. `[]` means "an array of these". */
  readonly fields: readonly string[]
  /** What the screen does with them, so a backend card knows what matters. */
  readonly note: string
}

export const SCREEN_FIXTURE_DEPENDENCIES: readonly ScreenFixtureDependency[] = [
  {
    screen: 'App shell — navigation rail',
    route: 'GET /api/account',
    fields: ['domain.state', 'connections.lastScanAt'],
    note: 'Only `ready_for_planning` unlocks the four product destinations. A null scan timestamp keeps Opportunities marked as still filling, so this field must be null until the first scan actually produces something — not set optimistically when the scan starts.',
  },
  {
    screen: 'App shell — banner stack',
    route: 'GET /api/account',
    fields: [
      'subscription.status',
      'connections.shopify',
      'connections.searchConsole',
      'limitedIntelligence',
      'servicePaused',
    ],
    note: '`past_due` raises the payment banner; `broken` on either connection raises its reconnect banner. `limitedIntelligence` must be false whenever Search Console is `broken`, or the merchant is told the same thing twice.',
  },
  {
    screen: 'App shell — browser analytics',
    route: 'GET /api/account',
    fields: ['accountId', 'domain.normalized'],
    note: 'The account id is who the analytics vendor is told is using the product; the normalised domain is the group every cost and usage question is asked by. They are the same two the server-side events already carry, so a click in a screen and a job on a queue land on one story rather than two. Neither is rendered — an account response missing them draws exactly the same screen and simply reports nothing. `domain.normalized` must be the *claimed* domain and never a host a visitor typed into the preview, or a stranger’s browsing would be attributed to a real store.',
  },
  {
    screen: 'App shell — banner stack',
    route: 'GET /api/settings',
    fields: ['vacationMode'],
    note: 'Vacation mode is a publishing setting rather than an account fact, so the shell needs both responses to decide what to show.',
  },
  {
    screen: 'Onboarding — which stage the dashboard shows',
    route: 'GET /api/account',
    fields: ['domain.state', 'connections.shopify', 'connections.lastScanAt'],
    note: 'The domain state alone does not decide the screen. `awaiting_shopify_auth` means two opposite things — a store that has never connected, and one whose token was revoked — and `connections.shopify` is what tells them apart, so it must read `broken` (not `none`) after a revocation. `lastScanAt` must stay null until the first scan has actually produced opportunities: it is what ends the "finding your opportunities" wait, and setting it when the scan *starts* would send the merchant to an empty list.',
  },
  {
    screen: 'Onboarding — setup progress list',
    route: 'GET /api/ingestion/status',
    fields: ['steps', 'startedAt', 'status'],
    note: 'Every row needs `step`, `state` and `startedAt`. Nine step names collapse into seven rows, so all nine must keep the names in the response schema. `startedAt` must be the time *that step* began, not the run: it is what the elapsed readout counts from, and a run-level timestamp would tell a merchant the last step has been going for twenty minutes. A step not yet reached may be absent from the array; the screen treats a missing step as not started.',
  },
  {
    screen: 'Onboarding — setup progress list',
    route: 'GET /api/ingestion/stream',
    fields: ['steps'],
    note: 'The stream must send whole status bodies of the same shape as the status route, one per transition, as `data:` frames. The screen falls back to polling the status route when the stream fails, and the two must be interchangeable — a stream sending diffs rather than snapshots would make the fallback show something different.',
  },
  {
    screen: 'Onboarding — confirmation review',
    route: 'GET /api/profile',
    fields: [
      'description',
      'language',
      'country',
      'audience',
      'tone',
      'topProducts',
      'keywords',
      'competitors',
      'competitorSuggestions',
      'families',
      'richness.band',
      'richness.productsMissingDetails',
      'searchConsole.connected',
      'searchConsole.property',
    ],
    note: 'Each `topProducts` row needs `id`, `title`, `source` and `pinned`; the order of the array is the ranking, and the confirm request sends it back as `topProductIds`. Each keyword needs `enrichmentState` — a term still being priced renders as "fetching", never as a volume of zero, so `monthlySearchVolume` must be null rather than 0 while pending. Each competitor needs `source` so auto and hand-added are distinguishable, and `competitorSuggestions` must carry only domains seen ranking, never entries already in `competitors`. Families need `axes` and `groupingSource`. `richness.productsMissingDetails` is a count; the screen does not name the products, because the response carries no list of them.',
  },
  {
    screen: 'Onboarding — landing on the first scan',
    route: 'GET /api/opportunities',
    fields: ['counts.open', 'limitedIntelligence', 'lastScanAt'],
    note: '`counts.open` is the number in the headline, so it must be the count of open opportunities rather than of everything ever found. `lastScanAt` non-null is what ends the wait and moves the merchant here, so it must not be written before the scan has produced something. `limitedIntelligence` decides whether the headline carries the badge and whether the explainer strip ends with the Search Console nudge.',
  },
]

/** Reads `a.b.c` out of a fixture body, treating a missing key as undefined. */
export function readPath(body: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (value === null || typeof value !== 'object') return undefined
    return (value as Record<string, unknown>)[key]
  }, body)
}
