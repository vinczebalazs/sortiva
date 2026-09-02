/**
 * The things a merchant does that only the browser can see.
 *
 * Most of what the product measures is emitted by the server when work happens.
 * These are the exceptions — a click, a drag, a card being read — which no
 * server call can observe. They use the same snake_case naming and the same
 * per-domain grouping as the server-side events, so the two sit in one funnel
 * rather than two.
 *
 * Each event declares exactly which properties it may carry. That is the point
 * of the table below: a call site cannot attach an arbitrary field, so article
 * text, a topic title or a recommendation body cannot reach the analytics
 * vendor by someone passing an extra property in a hurry. Only ids, enumerated
 * names and counts are expressible here.
 */

/** Values an analytics property may hold. Deliberately not `unknown`. */
export type PropertyValue = string | number | boolean | null

export interface UiEventShapes {
  /** An opportunity card was actually read, not merely listed. */
  opportunity_viewed: { opportunity_id: string; signal_type: string; recommended_action: string }
  /** The primary action on an opportunity card was clicked. */
  opportunity_action_clicked: { opportunity_id: string; action: string }
  /** An opportunity was dismissed from the list. */
  opportunity_dismissed: { opportunity_id: string; signal_type: string }
  /** A planned topic was vetoed from the calendar. */
  topic_veto_clicked: { topic_id: string; days_ahead: number }
  /** A topic was dragged to another day, or swapped with the topic there. */
  calendar_topic_dragged: { topic_id: string; days_moved: number; swapped: boolean }
  /** A draft that failed the quality bar was published anyway. */
  override_confirmed: { article_id: string; failing_criteria_count: number }
  /** One field of a page-improvement recommendation was copied. */
  recommendation_copied: { opportunity_id: string; field: string }
  /** A merchant task on Products was opened. */
  merchant_task_opened: { opportunity_id: string; missing_field_count: number }
  /** A notice in the account strip was dismissed. */
  banner_dismissed: { banner: string }
  /** A locked destination was clicked before the store was connected. */
  locked_nav_clicked: { nav_item: string; domain_state: string }
}

export type UiEventName = keyof UiEventShapes

/** The property table, widened only as far as "a record of primitive values". */
export type UiEventProperties<E extends UiEventName> = UiEventShapes[E] & {
  readonly [key: string]: PropertyValue
}

export const UI_EVENT_NAMES = [
  'opportunity_viewed',
  'opportunity_action_clicked',
  'opportunity_dismissed',
  'topic_veto_clicked',
  'calendar_topic_dragged',
  'override_confirmed',
  'recommendation_copied',
  'merchant_task_opened',
  'banner_dismissed',
  'locked_nav_clicked',
] as const satisfies readonly UiEventName[]
