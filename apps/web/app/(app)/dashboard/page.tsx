import { resolveOnboardingSurface } from '@sortiva/ui'
import '@sortiva/ui/styles/onboarding.css'
import { loadOnboardingData } from '../_lib/onboarding-data'
import { OnboardingScreen } from './OnboardingScreen'

/**
 * The dashboard, which is also the whole of onboarding.
 *
 * A merchant setting a store up never leaves this address: the domain's state
 * decides what is on screen, so there is no wizard to be halfway through and no
 * step that can be reached out of order or bookmarked after it is over.
 *
 * The steady-state dashboard — the growth headline, the month strip, the
 * attention list — is a separate screen with its own card. This page stops at
 * the point onboarding ends and leaves it a slot to fill.
 */

export const dynamic = 'force-dynamic'

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { account, status } = await loadOnboardingData()
  const surface = resolveOnboardingSurface({ account, status })
  const params = await searchParams

  if (surface === 'complete') {
    return <div data-dashboard-slot="steady_state" />
  }

  return (
    <OnboardingScreen
      account={account}
      initialStatus={status}
      // Google sends the merchant back with the outcome in the address, and a
      // granted connection still needs them to say which site this is.
      searchConsoleReturned={params.gsc === 'granted'}
    />
  )
}
