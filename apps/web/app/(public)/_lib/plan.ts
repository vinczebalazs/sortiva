import { headers } from 'next/headers'
import type { PlanResponse } from '@sortiva/ui'

/**
 * The plan, as the landing page and the purchase screen both need it.
 *
 * It is fetched over our own API rather than read from Stripe here, for the
 * same reason the app frame fetches the account: the screen then runs unchanged
 * against the mock server it was built on and against the real endpoint. The
 * endpoint is public — the amounts on it are the ones Stripe Checkout would
 * show anyway — so no session is needed to render the card.
 *
 * A null result means Stripe could not be read. The pricing block still
 * renders: the cap line is the sentence it exists to state, and it is true
 * whatever the price is.
 */
export async function loadPlan(): Promise<PlanResponse | null> {
  const headerList = await headers()
  const host = headerList.get('host') ?? 'localhost:3000'
  const protocol = headerList.get('x-forwarded-proto') ?? 'http'

  try {
    const response = await fetch(new URL('/api/billing/plan', `${protocol}://${host}`), {
      cache: 'no-store',
    })
    if (!response.ok) return null
    return (await response.json()) as PlanResponse
  } catch {
    return null
  }
}
