/**
 * The things a merchant does that only the browser can see.
 *
 * Most of what the product measures is emitted by the server when work happens.
 * These are the exceptions — a click, a drag, a card being read — which no
 * server call can observe. They use the same snake_case naming and the same
 * per-domain grouping as the server-side events, so the two sit in one funnel
 * rather than two.
 *
 * **This table is the guard, not a description of one.** The browser now talks
 * to the analytics vendor itself, so no code of ours sits between a screen and
 * the wire to inspect what is leaving. What stops a product name, an article
 * title or a draft body reaching the vendor is therefore this file:
 *
 * - Every event declares its properties by name, and a property that is not
 *   named here is dropped before the event is sent. A call site cannot attach a
 *   field.
 * - Every declared property also declares its *kind*, and there are four, none
 *   of which can hold a sentence: an identifier, an enumerated name, a count, or
 *   a yes/no. The three values that reached the vendor through the server-side
 *   wrapper when it was tested — an article title, an article body, a prompt —
 *   all contain spaces and run past sixty-four characters, so none of them is
 *   expressible as any kind here.
 *
 * Adding a property to an event means adding it here, which is the point: the
 * question "can this event carry text?" is answered by one table rather than by
 * reading every call site.
 */

import { scrubString } from '@sortiva/core/observability/scrub'

/** Values an analytics property may hold. Deliberately not `unknown`. */
export type PropertyValue = string | number | boolean

/**
 * What a property is allowed to be.
 *
 * - `id` — a row identifier we generated. No spaces, sixty-four characters at most.
 * - `enum` — one of a fixed set of names we chose, such as `OPTIMIZE` or
 *   `gsc_reconnect`. Same shape rule as an identifier.
 * - `count` — a number: a quantity, a position, a number of days.
 * - `flag` — a yes or a no.
 *
 * There is deliberately no kind for text. Adding one is the change that would
 * let store data reach the vendor, so it is a change to argue about rather than
 * a property slipping in unnoticed.
 */
export type PropertyKind = 'id' | 'enum' | 'count' | 'flag'

export const PROPERTY_KINDS = ['id', 'enum', 'count', 'flag'] as const satisfies readonly PropertyKind[]

/**
 * Identifiers and enumerated names share one shape rule: printable, no
 * whitespace, at most sixty-four characters. The length is what makes it a
 * guarantee rather than a hope — a headline or a paragraph fails it even after
 * someone has stripped the spaces out.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_.:@/-]{1,64}$/

/** The property table. One row per event; each property names what it may hold. */
const UI_EVENT_DEFINITIONS = {
  /** An opportunity card was actually read, not merely listed. */
  opportunity_viewed: { opportunity_id: 'id', signal_type: 'enum', recommended_action: 'enum' },
  /** The primary action on an opportunity card was clicked. */
  opportunity_action_clicked: { opportunity_id: 'id', action: 'enum' },
  /** An opportunity was dismissed from the list. */
  opportunity_dismissed: { opportunity_id: 'id', signal_type: 'enum' },
  /** A planned topic was vetoed from the calendar. */
  topic_veto_clicked: { topic_id: 'id', days_ahead: 'count' },
  /** A topic was dragged to another day, or swapped with the topic there. */
  calendar_topic_dragged: { topic_id: 'id', days_moved: 'count', swapped: 'flag' },
  /** A draft that failed the quality bar was published anyway. */
  override_confirmed: { article_id: 'id', failing_criteria_count: 'count' },
  /** One field of a page-improvement recommendation was copied. */
  recommendation_copied: { opportunity_id: 'id', field: 'enum' },
  /** A merchant task on Products was opened. */
  merchant_task_opened: { opportunity_id: 'id', missing_field_count: 'count' },
  /** A notice in the account strip was dismissed. */
  banner_dismissed: { banner: 'enum' },
  /** A locked destination was clicked before the store was connected. */
  locked_nav_clicked: { nav_item: 'enum', domain_state: 'enum' },
} as const satisfies Record<string, Record<string, PropertyKind>>

export type UiEventDefinitions = typeof UI_EVENT_DEFINITIONS

export type UiEventName = keyof UiEventDefinitions

type ValueOfKind<K> = K extends 'id' | 'enum' ? string : K extends 'count' ? number : boolean

/** The typed shape of each event, derived from the table above so the two cannot drift. */
export type UiEventShapes = {
  [E in UiEventName]: { [P in keyof UiEventDefinitions[E]]: ValueOfKind<UiEventDefinitions[E][P]> }
}

export const UI_EVENT_NAMES = Object.keys(UI_EVENT_DEFINITIONS) as readonly UiEventName[]

/** The declared properties of one event: names paired with what each may hold. */
export function propertiesOf(event: UiEventName): Readonly<Record<string, PropertyKind>> {
  return UI_EVENT_DEFINITIONS[event]
}

/** Every event paired with its declared properties — for checks that run over the whole table. */
export function allEventDefinitions(): readonly (readonly [
  UiEventName,
  Readonly<Record<string, PropertyKind>>,
])[] {
  return UI_EVENT_NAMES.map((event) => [event, propertiesOf(event)] as const)
}

/** Whether a value is something this kind can hold. */
export function acceptsValue(kind: PropertyKind, value: unknown): value is PropertyValue {
  switch (kind) {
    case 'id':
    case 'enum':
      // A vendor access token is exactly the shape of an identifier — no
      // spaces, short enough — so shape alone would let one through under a key
      // like `opportunity_id`. The same secret matcher the server-side wrapper
      // uses rejects it here. Rejected rather than redacted: an id that is
      // really a token is a bug, and `[redacted]` in its place is a worse
      // event than no property at all.
      return typeof value === 'string' && TOKEN_SHAPE.test(value) && scrubString(value) === value
    case 'count':
      return typeof value === 'number' && Number.isFinite(value)
    case 'flag':
      return typeof value === 'boolean'
  }
}

export interface RejectedProperty {
  readonly key: string
  /** `undeclared` — this event has no such property. `wrong_shape` — it has one, but not holding this. */
  readonly reason: 'undeclared' | 'wrong_shape'
}

export interface CheckedProperties {
  readonly properties: Record<string, PropertyValue>
  readonly rejected: readonly RejectedProperty[]
}

/**
 * Everything a screen reports passes through here before it goes anywhere.
 *
 * A rejected property is dropped, never sent and never thrown over: telemetry
 * must not be able to break a screen. What it must not do is guess — an
 * unrecognised field is dropped whole rather than truncated or coerced, because
 * the first sixty-four characters of an article title are still an article
 * title.
 */
export function checkEventProperties(
  event: UiEventName,
  properties: Readonly<Record<string, unknown>>,
): CheckedProperties {
  const declared = propertiesOf(event)
  const accepted: Record<string, PropertyValue> = {}
  const rejected: RejectedProperty[] = []

  for (const [key, value] of Object.entries(properties)) {
    const kind = declared[key]
    if (kind === undefined) {
      rejected.push({ key, reason: 'undeclared' })
      continue
    }
    if (!acceptsValue(kind, value)) {
      rejected.push({ key, reason: 'wrong_shape' })
      continue
    }
    accepted[key] = value
  }

  return { properties: accepted, rejected }
}
