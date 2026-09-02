'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { accountAttribution } from '@sortiva/core/contracts/analytics'
import {
  browserAnalyticsInitOptions,
  createPosthogUiAnalytics,
  DEFAULT_POSTHOG_HOST,
  type PosthogBrowserClient,
} from './browser'
import { noopUiAnalytics, type UiAnalytics } from './client'
import { sessionReplay } from './replay'

/**
 * Hands every screen inside it something to report to.
 *
 * Screens ask for `useUiAnalytics()` and get an object with one method. What
 * they get back is the do-nothing default until the vendor's library has
 * loaded, and stays the default forever if it never does — a merchant running
 * an ad blocker, or a deployment with no analytics project configured, uses the
 * product exactly as anyone else does.
 *
 * The library is fetched only once this is running in a browser, so nothing
 * server-rendered and no test pulls it in.
 */

const UiAnalyticsContext = createContext<UiAnalytics>(noopUiAnalytics)

export function useUiAnalytics(): UiAnalytics {
  return useContext(UiAnalyticsContext)
}

export interface AnalyticsProviderProps {
  /** The signed-in account. Nothing is reported before there is one. */
  readonly accountId: string | null
  /** The claimed domain, which is how cost and usage questions are grouped. Null until claimed. */
  readonly domain: string | null
  /** The analytics project's public key. Absent in development and in any deployment without a project. */
  readonly projectKey: string | null
  readonly host?: string | null
  /** The route being shown, which decides whether this view could ever be recorded. */
  readonly route: string
  readonly children: ReactNode
}

export function AnalyticsProvider({
  accountId,
  domain,
  projectKey,
  host,
  route,
  children,
}: AnalyticsProviderProps) {
  const [client, setClient] = useState<PosthogBrowserClient | null>(null)
  const [analytics, setAnalytics] = useState<UiAnalytics>(noopUiAnalytics)
  // The view the merchant landed on. The library starts once and navigating
  // inside the app must not restart it, so the starting route is frozen here;
  // the second effect below is what keeps the recording decision correct
  // afterwards.
  const [landingRoute] = useState(route)

  useEffect(() => {
    if (!projectKey || !accountId) return
    let abandoned = false

    void import('posthog-js')
      .then(({ default: posthog }) => {
        if (abandoned) return
        posthog.init(
          projectKey,
          browserAnalyticsInitOptions(landingRoute, host ?? DEFAULT_POSTHOG_HOST),
        )
        posthog.identify(accountId)
        setClient(posthog)
        setAnalytics(createPosthogUiAnalytics(posthog, accountAttribution(accountId, domain ?? undefined)))
      })
      .catch(() => {
        // A vendor script that will not load is not a reason a merchant cannot
        // use the product. They keep the do-nothing default.
      })

    return () => {
      abandoned = true
    }
  }, [projectKey, accountId, domain, host, landingRoute])

  useEffect(() => {
    if (!client) return
    // The library starts once, on whichever view the merchant landed on. Moving
    // from a view that could be recorded to one that renders their store must
    // stop the recording rather than inherit the earlier answer.
    if (sessionReplay(route) === 'off') client.stopSessionRecording()
  }, [client, route])

  return <UiAnalyticsContext.Provider value={analytics}>{children}</UiAnalyticsContext.Provider>
}
