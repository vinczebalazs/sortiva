'use client'

import { useEffect, useState } from 'react'
import { t as defaultTranslate, type StringKey, type Translate } from '../strings'

/**
 * The wait between confirming a profile and seeing what the product found.
 *
 * Confirmation is not the end of setting a store up — the first set of
 * opportunities is. This card is what that wait looks like: a few minutes, and
 * an explicit invitation to leave, because a merchant who feels pinned to a
 * progress bar for five minutes remembers the wait rather than what arrived at
 * the end of it.
 *
 * The five lines name the work in the order it happens. They are named and not
 * ticked off: the API has no feed of the scan's progress yet, and a tick that
 * moved on a timer rather than on the work would be a lie told in the one place
 * the product is asking to be trusted. `stageStates` is where a real feed
 * plugs in, one prop, when a route for it exists.
 */

export type ScanStageId = 'ranking' | 'striking' | 'competitors' | 'families' | 'scoring'

export const SCAN_STAGES: readonly { id: ScanStageId; labelKey: StringKey }[] = [
  { id: 'ranking', labelKey: 'finding.stage.ranking' },
  { id: 'striking', labelKey: 'finding.stage.striking' },
  { id: 'competitors', labelKey: 'finding.stage.competitors' },
  { id: 'families', labelKey: 'finding.stage.families' },
  { id: 'scoring', labelKey: 'finding.stage.scoring' },
]

export type ScanStageState = 'pending' | 'active' | 'done'

/** How often the card asks whether the scan has produced anything yet. */
export const SCAN_POLL_MS = 5_000

export interface FindingOpportunitiesProps {
  readonly t?: Translate
  /**
   * Per-stage progress, once something reports it. Absent today: every stage
   * renders as work in flight rather than as finished or not started.
   */
  readonly stageStates?: Partial<Record<ScanStageId, ScanStageState>>
  readonly opportunitiesEndpoint?: string
  /** Called once the scan has produced its first opportunities. */
  readonly onComplete?: () => void
  readonly pollMs?: number
}

interface ScanProgress {
  readonly lastScanAt: string | null
}

/**
 * Whether the scan has produced something to look at.
 *
 * The scan timestamp is the fact, and it is the same one the navigation rail
 * reads to stop calling Opportunities "still filling" — so the wait and the
 * rail cannot disagree about whether onboarding is over. It must not be
 * written when the scan *starts*, or this sends the merchant to an empty list.
 */
export function scanProduced(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false
  const lastScanAt = (body as ScanProgress).lastScanAt
  return typeof lastScanAt === 'string' && lastScanAt.length > 0
}

export function FindingOpportunities({
  t = defaultTranslate,
  stageStates,
  opportunitiesEndpoint = '/api/opportunities',
  onComplete,
  pollMs = SCAN_POLL_MS,
}: FindingOpportunitiesProps) {
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (done) return
    let stopped = false

    const ask = async () => {
      try {
        const response = await fetch(opportunitiesEndpoint, { cache: 'no-store' })
        if (!response.ok) return
        if (scanProduced(await response.json()) && !stopped) {
          setDone(true)
          onComplete?.()
        }
      } catch {
        // The next ask is a few seconds away.
      }
    }

    void ask()
    const timer = setInterval(() => void ask(), pollMs)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [done, onComplete, opportunitiesEndpoint, pollMs])

  return (
    <section className="sortiva-onboarding-card sortiva-finding" data-onboarding-card="finding_opportunities">
      <h1 className="sortiva-onboarding-card__heading">{t('finding.heading')}</h1>
      <p className="sortiva-onboarding-card__body">{t('finding.body')}</p>
      <ol className="sortiva-finding__stages" aria-label={t('finding.stagesLabel')}>
        {SCAN_STAGES.map((stage) => (
          <li key={stage.id} data-scan-stage={stage.id} data-stage-state={stageStates?.[stage.id] ?? 'active'}>
            {t(stage.labelKey)}
          </li>
        ))}
      </ol>
    </section>
  )
}
