import type { UiEventName, UiEventShapes } from './events'

/**
 * How a screen reports what the merchant did.
 *
 * Screens call this and nothing else. What carries the event to the analytics
 * vendor is deliberately not decided here — see the note in `DECISIONS.md` for
 * T9.1 — so every screen can be built and tested now, and the transport is
 * bound in one place later without touching a single call site.
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
  readonly properties: Record<string, unknown>
}

/** The test double: remembers what a screen reported, so a test can assert on it. */
export class RecordingUiAnalytics implements UiAnalytics {
  readonly events: RecordedUiEvent[] = []

  capture<E extends UiEventName>(event: E, properties: UiEventShapes[E]): void {
    this.events.push({ event, properties: { ...properties } })
  }

  named(event: UiEventName): readonly RecordedUiEvent[] {
    return this.events.filter((recorded) => recorded.event === event)
  }

  clear(): void {
    this.events.length = 0
  }
}
