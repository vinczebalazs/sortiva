import { ActivationHeader, OpportunitiesScreen, type OpportunityListResponse } from '@sortiva/ui'
import '@sortiva/ui/styles/onboarding.css'
import '@sortiva/ui/styles/opportunities.css'
import { getJson, requestContext } from '../_lib/api'

/**
 * Where the first scan lands a merchant, and where they come back to
 * afterwards.
 *
 * The header is the activation moment — the count of what was found and, once
 * ever, one sentence about each of the four things the product can do — and it
 * is drawn on the server so the merchant reads it in the first frame. The list
 * underneath is handed the same response and takes over from there, because
 * everything it does afterwards (opening one, dismissing one, undoing that) is
 * a conversation with the browser.
 *
 * A read that failed renders the header with nothing found rather than an error
 * page: the count is the least important thing on a screen whose job is to say
 * what to do next.
 */

export const dynamic = 'force-dynamic'

const EMPTY: OpportunityListResponse = {
  opportunities: [],
  counts: { open: 0, byAction: {} },
  lastScanAt: null,
  nextScanAt: null,
  limitedIntelligence: false,
  cursor: null,
}

export default async function OpportunitiesPage() {
  const data =
    (await getJson<OpportunityListResponse>('/api/opportunities', await requestContext())) ?? EMPTY

  return (
    <>
      <ActivationHeader count={data.counts.open} limitedIntelligence={data.limitedIntelligence} />
      <OpportunitiesScreen initialData={data} />
    </>
  )
}
