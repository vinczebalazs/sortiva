import { ActivationHeader } from '@sortiva/ui'
import '@sortiva/ui/styles/onboarding.css'
import { getJson, requestContext } from '../_lib/api'

/**
 * Where the first scan lands a merchant, and where they come back to
 * afterwards.
 *
 * This card builds the top of it: the count of what was found, and — once,
 * ever — the one-sentence explanation of each of the four things the product
 * can do about them. That header is the activation moment; the list of
 * opportunities beneath it is the central surface of the product and has its
 * own card, so the slot below is deliberately empty here.
 */

export const dynamic = 'force-dynamic'

interface OpportunitiesSummary {
  readonly counts: { readonly open: number }
  readonly limitedIntelligence: boolean
}

export default async function OpportunitiesPage() {
  const summary = await getJson<OpportunitiesSummary>('/api/opportunities', await requestContext())

  return (
    <>
      <ActivationHeader
        count={summary?.counts.open ?? 0}
        limitedIntelligence={summary?.limitedIntelligence ?? false}
      />
      <div data-opportunities-slot="list" />
    </>
  )
}
