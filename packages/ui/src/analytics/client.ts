import {
  checkEventProperties,
  type PropertyValue,
  type RejectedProperty,
  type UiEventName,
  type UiEventShapes,
} from './events'

/**
 * How a screen reports what the merchant did.
 *
 * Screens call this and nothing else. Which vendor carries the event, and how,
 * is decided in `browser.ts` — the only file in the product that knows the
 * vendor exists — so a screen is testable with no vendor and no network, and
 * the vendor can change without touching a call site.
 */
export interface UiAnalytics {
  capture<E extends UiEventName>(event: E, properties: UiEventShapes[E]): void
}

/**
 * The default. Screens must work with analytics switched off — a merchant with
 * a blocker installed still has to be able to use the product — so doing
 * nothing is a correct implementation, not a stub.
 */
export const noopUiAnalytics: UiAnalytics = { capture: () => {} }

export interface RecordedUiEvent {
  readonly event: UiEventName
  readonly properties: Record<string, PropertyValue>
  /** What the property table refused, if anything. Empty on every ordinary call. */
  readonly rejected: readonly RejectedProperty[]
}

/**
 * The test double: remembers what a screen reported, so a test can assert on it.
 *
 * It runs the *same* property check as the live transport, so a test asserting
 * "an article title cannot reach analytics" is asserting production behaviour
 * rather than the double's.
 */
export class RecordingUiAnalytics implements UiAnalytics {
  readonly events: RecordedUiEvent[] = []

  capture<E extends UiEventName>(event: E, properties: UiEventShapes[E]): void {
    const checked = checkEventProperties(event, properties)
    this.events.push({ event, properties: checked.properties, rejected: checked.rejected })
  }

  named(event: UiEventName): readonly RecordedUiEvent[] {
    return this.events.filter((recorded) => recorded.event === event)
  }

  /** Everything the property table refused across every event recorded so far. */
  get rejected(): readonly RejectedProperty[] {
    return this.events.flatMap((recorded) => recorded.rejected)
  }

  clear(): void {
    this.events.length = 0
  }
}
