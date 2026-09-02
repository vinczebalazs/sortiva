import {
  resolveAttribution,
  type EventAttribution,
} from '@sortiva/core/contracts/analytics'
import type { UiAnalytics } from './client'
import { checkEventProperties, type UiEventName, type UiEventShapes } from './events'
import { sessionReplay } from './replay'

/**
 * The one file that knows the analytics vendor exists in a browser.
 *
 * Screens report through `UiAnalytics`; this turns a report into a call on the
 * vendor's browser library. Two things happen on the way and both are the point
 * of routing every event through here:
 *
 * - **The property table is applied.** Anything a screen attached that its event
 *   does not declare is dropped before the vendor sees it (`events.ts`).
 * - **The account attribution the server-side wrapper applies is applied here
 *   too**, from the same function, so a browser event and a server event about
 *   the same store land on the same person and the same domain group rather
 *   than in two unrelated piles.
 *
 * A lint rule makes this directory the only place allowed to import the
 * vendor's library, so a screen cannot reach past the table and capture
 * whatever it likes.
 */

/**
 * What we use of the vendor's browser library. Narrow on purpose: a fake in a
 * test is three methods, and anything the wider library can do — recording a
 * session, capturing every click by itself — is not reachable from here.
 */
export interface PosthogBrowserClient {
  identify(distinctId: string): void
  capture(event: string, properties?: Record<string, unknown>): void
  stopSessionRecording(): void
}

export interface BrowserAnalyticsInitOptions {
  readonly api_host: string
  readonly disable_session_recording: boolean
  readonly autocapture: boolean
  readonly capture_pageview: boolean
  readonly capture_pageleave: boolean
  readonly capture_performance: boolean
  readonly disable_surveys: boolean
  readonly rageclick: boolean
  readonly person_profiles: 'identified_only'
}

/** Where events go when nothing says otherwise. The EU project, matching the server side. */
export const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com'

/**
 * How the vendor's library is started. Everything it does on its own is
 * switched off, so the only events that exist are the ten a screen can report:
 *
 * - **Autocapture** would record every click along with the text of whatever
 *   was clicked. On a product list or a draft, that text is the merchant's
 *   store. This is the setting that would defeat the property table.
 * - **Page views and page leaves** would put a second, browser-side version of
 *   the funnel beside the server-side one the product already emits, and the
 *   funnel numbers would then depend on which of the two you counted.
 * - **Session recording** is off for the reasons in `replay.ts`; the route
 *   decides, and every store-data route decides against.
 * - **Surveys and rage clicks** are vendor features nobody has asked for, and
 *   both put things on the merchant's screen that we did not write.
 * - **Profiles for identified users only** keeps the product from creating a
 *   person record for a visitor who never signs in.
 */
export function browserAnalyticsInitOptions(
  route: string,
  host: string = DEFAULT_POSTHOG_HOST,
): BrowserAnalyticsInitOptions {
  return {
    api_host: host,
    disable_session_recording: sessionReplay(route) === 'off',
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_performance: false,
    disable_surveys: true,
    rageclick: false,
    person_profiles: 'identified_only',
  }
}

/**
 * Binds the reporting seam to the vendor's browser library.
 *
 * A failure to send is swallowed. Analytics is telemetry: a merchant whose
 * network dropped an event still has to be able to click the next thing.
 */
export function createPosthogUiAnalytics(
  client: PosthogBrowserClient,
  attribution: EventAttribution,
): UiAnalytics {
  const resolved = resolveAttribution(attribution)

  return {
    capture<E extends UiEventName>(event: E, properties: UiEventShapes[E]): void {
      const checked = checkEventProperties(event, properties)
      try {
        client.capture(event, {
          ...resolved.properties,
          ...checked.properties,
          ...(Object.keys(resolved.groups).length > 0 ? { $groups: resolved.groups } : {}),
        })
      } catch {
        // Telemetry never breaks a screen.
      }
    },
  }
}

/** Who the vendor should think is using the product. */
export function browserDistinctId(attribution: EventAttribution): string {
  return resolveAttribution(attribution).distinctId
}
