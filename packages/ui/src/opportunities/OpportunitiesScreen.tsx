'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useUiAnalytics } from '../analytics'
import { t as defaultTranslate, type Translate } from '../strings'
import { OpportunityDrawer } from './OpportunityDrawer'
import { OpportunityList } from './OpportunityList'
import {
  createOpportunityActions,
  httpOpportunitiesApi,
  type OpportunitiesApi,
  type Toast,
} from './actions'
import type { OpportunityDetail, OpportunityListResponse, OpportunityRow } from './types'

/**
 * The Opportunities screen: the list, the drawer over it, and the notices that
 * follow what the merchant did.
 *
 * The page renders the activation header and hands the first list down already
 * loaded, so the merchant reads the headline before any of this has thought
 * about the network. Everything after that first frame happens here — opening
 * one, dismissing one, undoing that, and being told when the latest scan moved
 * something under them.
 *
 * What is reported to analytics is deliberately thin: the id of the thing, the
 * signal that produced it, and which button. Not its title, not its why-line —
 * both are the merchant's own store described back to them, and the event table
 * has no kind that could carry either.
 */

/** How long an undo stays on offer. Long enough to change your mind, short enough not to nag. */
const UNDO_MS = 5000

export interface OpportunitiesScreenProps {
  readonly initialData: OpportunityListResponse
  readonly t?: Translate
  /** Swapped for a double in tests; the default talks to `/api/opportunities`. */
  readonly api?: OpportunitiesApi
  readonly productsHref?: string
  readonly toastMs?: number
}

export function OpportunitiesScreen({
  initialData,
  t = defaultTranslate,
  api,
  productsHref = '/products',
  toastMs = UNDO_MS,
}: OpportunitiesScreenProps) {
  const analytics = useUiAnalytics()
  const [data, setData] = useState(initialData)
  const [hidden, setHidden] = useState<readonly string[]>([])
  const [busy, setBusy] = useState<readonly string[]>([])
  const [toasts, setToasts] = useState<readonly Toast[]>([])
  const [detail, setDetail] = useState<OpportunityDetail | null>(null)
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'failed'>('idle')
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  const client = useMemo(() => api ?? httpOpportunitiesApi(), [api])

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending) clearTimeout(timer)
    }
  }, [])

  function dropToast(id: string) {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }

  const actions = useMemo(
    () =>
      createOpportunityActions(
        client,
        {
          toast(toast) {
            setToasts((current) => [...current, toast])
            timers.current.push(setTimeout(() => dropToast(toast.id), toastMs))
          },
          refresh() {
            void client.list().then((next) => {
              // A read that failed is not news: the list on screen is still the
              // last thing the server actually said.
              if (next) {
                setData(next)
                setHidden([])
              }
            })
          },
          setHidden(id, isHidden) {
            setHidden((current) =>
              isHidden ? [...current, id] : current.filter((entry) => entry !== id),
            )
          },
          setBusy(id, isBusy) {
            setBusy((current) => (isBusy ? [...current, id] : current.filter((entry) => entry !== id)))
          },
        },
        t,
      ),
    [client, t, toastMs],
  )

  async function openDetail(row: OpportunityRow) {
    analytics.capture('opportunity_viewed', {
      opportunity_id: row.id,
      signal_type: row.signalType,
      recommended_action: row.recommendedAction,
    })
    setDetailState('loading')
    const loaded = await client.detail(row.id)
    if (loaded === null) {
      setDetailState('failed')
      return
    }
    setDetail(loaded)
    setDetailState('idle')
  }

  const visible = useMemo(
    () => ({ ...data, opportunities: data.opportunities.filter((row) => !hidden.includes(row.id)) }),
    [data, hidden],
  )

  return (
    <>
      <OpportunityList
        data={visible}
        t={t}
        busyIds={busy}
        context={{ productsHref }}
        onDetails={(row) => void openDetail(row)}
        onDismiss={(row) => {
          analytics.capture('opportunity_dismissed', {
            opportunity_id: row.id,
            signal_type: row.signalType,
          })
          void actions.dismiss(row)
        }}
        onPrimary={(row, action) => {
          analytics.capture('opportunity_action_clicked', {
            opportunity_id: row.id,
            action: action.kind,
          })
          if (action.kind === 'schedule' || action.kind === 'schedule_refresh') {
            void actions.schedule(row)
          } else if (action.kind === 'generate') {
            void actions.generate(row)
          } else if (action.kind === 'view_recommendation') {
            void openDetail(row)
          }
        }}
      />

      {detailState === 'loading' ? (
        <p className="sortiva-drawer__note" data-drawer-state="loading">
          {t('opportunities.detailLoading')}
        </p>
      ) : null}
      {detailState === 'failed' ? (
        <p className="sortiva-drawer__failed" role="alert" data-drawer-state="failed">
          {t('opportunities.detailFailed')}
        </p>
      ) : null}

      {detail ? (
        <OpportunityDrawer
          detail={detail}
          t={t}
          productsHref={productsHref}
          busy={busy.includes(detail.opportunity.id)}
          onClose={() => setDetail(null)}
          onCopy={(field) =>
            analytics.capture('recommendation_copied', {
              opportunity_id: detail.opportunity.id,
              field,
            })
          }
          onGenerate={() => void actions.generate(detail.opportunity)}
          onTask={(task, state) => void actions.markTask(detail.opportunity, task.id, state)}
          onMarkAllApplied={() => {
            for (const task of detail.tasks) {
              if (task.state === 'open') {
                void actions.markTask(detail.opportunity, task.id, 'applied')
              }
            }
          }}
        />
      ) : null}

      {toasts.length > 0 ? (
        <div
          className="sortiva-opps__toasts"
          role="status"
          aria-label={t('opportunities.toastLabel')}
        >
          {toasts.map((toast) => (
            <div key={toast.id} className="sortiva-toast" data-toast={toast.id}>
              <span>{toast.message}</span>
              {toast.undoLabel ? (
                <button
                  type="button"
                  className="sortiva-toast__action"
                  onClick={() => {
                    toast.onUndo?.()
                    dropToast(toast.id)
                  }}
                >
                  {toast.undoLabel}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </>
  )
}
