'use client'

import { usePathname } from 'next/navigation'
import { AnalyticsProvider, type AnalyticsProviderProps } from '@sortiva/ui'

/**
 * Supplies the one thing the shared provider cannot work out for itself: which
 * view is on screen.
 *
 * That answer decides whether the view could ever be recorded, and it changes
 * as the merchant moves around without the page reloading. Reading it needs
 * Next's router, and the shared component library is deliberately free of Next,
 * so the reading happens here and the deciding happens there.
 */
export function AnalyticsMount(props: Omit<AnalyticsProviderProps, 'route'>) {
  return <AnalyticsProvider {...props} route={usePathname() ?? '/'} />
}
