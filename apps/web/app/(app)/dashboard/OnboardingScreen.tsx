'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  ConnectDomain,
  ParkedShopifyDisconnectedCard,
  ParkedUnsupportedCard,
  SearchConsoleStep,
  ShopifyBlockingCard,
  Stepper,
  resolveOnboardingSurface,
  useIngestionStatus,
  type IngestionStatus,
  type ShellAccount,
} from '@sortiva/ui'

/**
 * The dashboard while a store is being set up.
 *
 * There is no wizard route in this product: every stage of setting a store up
 * happens here, and which one is on screen is decided by the state of the
 * domain rather than by where the merchant navigated. Closing the tab and
 * coming back lands them exactly where they left off.
 *
 * The page is rendered on the server with the run as it stood at that moment,
 * and this component keeps it moving from there. When the run crosses into
 * something the server would decide differently — the store granted access, or
 * the drafts are ready to review — it asks the server to render the page again
 * rather than trying to work out the new stage itself. One place decides what
 * is on screen, and it is the same place before and after the refresh.
 */

export interface OnboardingScreenProps {
  readonly account: ShellAccount
  readonly initialStatus: IngestionStatus | null
  /** True when Google has just sent the merchant back and a property is still unchosen. */
  readonly searchConsoleReturned: boolean
}

/** The run has reached a point the server would draw a different screen for. */
function runMovedOn(status: IngestionStatus | null): boolean {
  if (status === null) return false
  if (status.status !== 'running') return true
  return status.steps.some((step) => step.step === 'awaiting_confirmation' && step.state !== 'pending')
}

export function OnboardingScreen({
  account,
  initialStatus,
  searchConsoleReturned,
}: OnboardingScreenProps) {
  const router = useRouter()

  const serverSurface = resolveOnboardingSurface({ account, status: initialStatus })
  const following = serverSurface === 'ingesting' || serverSurface === 'shopify_blocking'

  const status = useIngestionStatus({ initial: initialStatus, enabled: following })
  const surface = resolveOnboardingSurface({ account, status })

  const refreshed = useRef(false)
  useEffect(() => {
    if (!following || refreshed.current || !runMovedOn(status)) return
    refreshed.current = true
    router.refresh()
  }, [following, router, status])

  const gscRunning = status?.steps.some(
    (step) => step.step === 'gsc_connect' && step.state === 'running',
  )

  switch (surface) {
    case 'connect_domain':
      return (
        <div className="sortiva-onboarding">
          <ConnectDomain onClaimed={() => router.refresh()} />
        </div>
      )

    case 'parked_unsupported':
      return (
        <div className="sortiva-onboarding">
          <ParkedUnsupportedCard />
        </div>
      )

    case 'parked_shopify_disconnected':
      return (
        <div className="sortiva-onboarding">
          <ParkedShopifyDisconnectedCard />
        </div>
      )

    case 'shopify_blocking':
      return (
        <div className="sortiva-onboarding">
          <ShopifyBlockingCard />
          <Stepper status={status} domain={account.domain?.normalized ?? null} />
        </div>
      )

    case 'ingesting':
      return (
        <div className="sortiva-onboarding">
          <Stepper status={status} domain={account.domain?.normalized ?? null} />
          {gscRunning || searchConsoleReturned ? (
            <SearchConsoleStep
              initialPhase={searchConsoleReturned ? 'picker' : 'connect'}
              onSettled={() => router.refresh()}
            />
          ) : null}
        </div>
      )

    default:
      // Confirmation, the first scan and the steady-state dashboard are
      // rendered by the page itself, which knows them without a browser.
      return null
  }
}
