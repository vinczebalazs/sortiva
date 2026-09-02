import { resolveOnboardingSurface, type ProfileDraft } from '@sortiva/ui'
import '@sortiva/ui/styles/onboarding.css'
import { getJson, requestContext } from '../_lib/api'
import { buildOnboardingData } from '../_lib/onboarding-data'
import { OnboardingScreen } from './OnboardingScreen'
import { ConfirmationSurface, FindingOpportunitiesSurface } from './ConfirmationSurface'

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

/** Where the first scan lands the merchant. Not the dashboard, deliberately. */
const OPPORTUNITIES = '/opportunities'

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const request = await requestContext()
  const { account, status } = await buildOnboardingData(request)
  const surface = resolveOnboardingSurface({ account, status })
  const params = await searchParams

  if (surface === 'complete') {
    return <div data-dashboard-slot="steady_state" />
  }

  if (surface === 'finding_opportunities') {
    return <FindingOpportunitiesSurface href={OPPORTUNITIES} />
  }

  if (surface === 'confirmation') {
    const profile = await getJson<ProfileDraft>('/api/profile', request)
    // A draft we could not read is not something to guess at: the run is still
    // the truth, so the merchant sees where it got to rather than an empty form
    // that would overwrite a profile with blanks if they submitted it.
    if (profile) return <ConfirmationSurface profile={profile} />
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
