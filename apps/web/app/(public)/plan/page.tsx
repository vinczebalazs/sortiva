import { loadPlan } from '../_lib/plan'
import { PlanScreen } from './PlanScreen'

/**
 * The plan card is readable without an account — the amounts on it are the ones
 * Stripe Checkout would show anyway — so a visitor can arrive here straight off
 * the landing page. Pressing Subscribe is the first thing that needs an
 * identity, and the endpoint answers 401; the screen sends them to sign in
 * rather than telling them the payment page is broken.
 */
export default async function PlanPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const returned = typeof params.checkout === 'string' ? params.checkout : null
  const plan = await loadPlan()

  return <PlanScreen plan={plan} returned={returned} />
}
