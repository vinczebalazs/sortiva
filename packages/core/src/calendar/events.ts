/**
 * The calendar's own PostHog event, main section 14.7's taxonomy:
 * "opportunity_status_changed (from, to, actor in user | autopilot |
 * expiry)". A veto is the one calendar action that changes an existing
 * opportunity's own lifecycle state (main section 7.9: "dismissed - user
 * said no; goes to the not-interested list"), so it is the one calendar
 * operation this event fires for. Move and pin change a topic's own row, not
 * an opportunity's status, and main section 14.7 names no event of its own
 * for either - see DECISIONS 2026-09-03 T4.2.
 */
export const OPPORTUNITY_STATUS_CHANGED_EVENT = 'opportunity_status_changed'

export interface OpportunityStatusChangedProperties {
  readonly from: string | null
  readonly to: string
  readonly actor: 'user' | 'autopilot' | 'expiry'
}
