'use client'

import { useRouter } from 'next/navigation'
import { ConfirmationReview, FindingOpportunities, type ProfileDraft } from '@sortiva/ui'

/**
 * The last two stages of setting a store up, both of which end by moving the
 * merchant somewhere else.
 *
 * Confirming turns the draft into the account's real profile and starts the
 * first scan, so the page has to be rendered again by the server to show the
 * wait. The wait ends on Opportunities rather than back here, because the
 * first set of opportunities — not the confirmation — is the moment the
 * product has actually done something.
 */

export function ConfirmationSurface({ profile }: { profile: ProfileDraft }) {
  const router = useRouter()
  return <ConfirmationReview profile={profile} onConfirmed={() => router.refresh()} />
}

export function FindingOpportunitiesSurface({ href }: { href: string }) {
  const router = useRouter()
  return <FindingOpportunities onComplete={() => router.push(href)} />
}
