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
]

/** Reads `a.b.c` out of a fixture body, treating a missing key as undefined. */
export function readPath(body: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (value === null || typeof value !== 'object') return undefined
    return (value as Record<string, unknown>)[key]
  }, body)
}
