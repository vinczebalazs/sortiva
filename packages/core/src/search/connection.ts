/**
 * Whether an account is running with Search Console data or without it.
 *
 * Deliberately **derived** rather than stored. The product's rule is that the
 * account runs in Limited Intelligence mode *until Search Console is connected*
 * — one entry condition and one exit condition, both about whether a working
 * connection exists. A stored flag would be a second source of truth able to
 * disagree with the connection in two visible ways: the warning badge stays up
 * after the merchant connects, or it reads "connected" with nothing to read, and
 * the signals that need search data get evaluated against no data at all.
 *
 * The merchant's explicit *skip* is durable elsewhere — the Search Console step
 * of the onboarding run ends `skipped` — so nothing is lost by not storing this.
 */

export interface GscConnectionRow {
  /** Empty until the merchant has picked a property: the grant exists, the connection does not yet. */
  readonly property: string
  /** Set when a token refresh found the grant gone. Reporting stops; the content pipeline carries on. */
  readonly invalidatedAt: Date | null
}

/** What the settings and dashboard surfaces show for the Search Console connection. */
export type SearchConsoleConnectionState = 'none' | 'connected' | 'broken'

export function searchConsoleConnectionState(
  conn: GscConnectionRow | null | undefined,
): SearchConsoleConnectionState {
  if (!conn || conn.property === '') return 'none'
  return conn.invalidatedAt ? 'broken' : 'connected'
}

/**
 * True when the engine has no search data to reason from, so the signals that
 * need it are not evaluated and the badge explaining that is shown.
 *
 * A *broken* connection is not limited intelligence: the grant died, but the
 * history we already synced is still there and still worth detecting on. What
 * the merchant sees for that case is a reconnect prompt, not the badge.
 */
export function isLimitedIntelligence(conn: GscConnectionRow | null | undefined): boolean {
  return searchConsoleConnectionState(conn) === 'none'
}
