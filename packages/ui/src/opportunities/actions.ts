import { t as defaultTranslate, type StringKey, type Translate } from '../strings'
import { formatDate } from './list'
import type { OpportunityDetail, OpportunityListResponse, OpportunityRow } from './types'

/**
 * What happens when a merchant presses one of the buttons on an opportunity,
 * and what they are told afterwards.
 *
 * Two things make this worth having apart from the components. Dismissing is
 * undoable, and an undo that only exists inside a rendered toast is an undo
 * nobody can test. And every one of these requests can come back 409 — the
 * scan re-reads the store weekly and re-scores what it finds, so an opportunity
 * can move underneath a merchant who has had the page open — which has to end
 * in a refreshed list and a sentence saying so, never in a silent failure or a
 * button that does nothing the second time.
 *
 * The network and the screen are both passed in, so the behaviour is provable
 * without either.
 */

export type PostOutcome =
  | { readonly ok: true; readonly body?: unknown }
  | { readonly ok: false; readonly conflict: string | null }

export interface OpportunitiesApi {
  list(): Promise<OpportunityListResponse | null>
  detail(id: string): Promise<OpportunityDetail | null>
  post(path: string, body?: unknown): Promise<PostOutcome>
}

export interface Toast {
  readonly id: string
  readonly message: string
  /** An undo offered alongside the message, for the five seconds it is up. */
  readonly undoLabel?: string
  readonly onUndo?: () => void
}

export interface ActionSurface {
  toast(toast: Toast): void
  /** The list moved under us: read it again rather than patching what we think we know. */
  refresh(): void
  /** Hidden from the list while the undo is still on offer. */
  setHidden(id: string, hidden: boolean): void
  setBusy(id: string, busy: boolean): void
}

/**
 * The sentence for a refused transition.
 *
 * Every one of these ends the same way — the list is re-read — so the message
 * says what happened rather than offering a retry that would race the same way.
 */
export function conflictMessage(code: string | null, t: Translate = defaultTranslate): string {
  if (code === 'opportunity_not_open') return t('opportunities.toast.notOpen')
  if (code === null) return t('opportunities.toast.failed')
  return t('opportunities.toast.conflict')
}

let counter = 0
function toastId(): string {
  counter += 1
  return `toast-${counter}`
}

export interface OpportunityActions {
  dismiss(row: OpportunityRow): Promise<void>
  schedule(row: OpportunityRow): Promise<void>
  generate(row: OpportunityRow): Promise<void>
  markTask(row: OpportunityRow, taskId: string, state: 'applied' | 'skipped'): Promise<void>
}

export function createOpportunityActions(
  api: OpportunitiesApi,
  surface: ActionSurface,
  t: Translate = defaultTranslate,
): OpportunityActions {
  async function run(row: OpportunityRow, path: string, body?: unknown): Promise<PostOutcome> {
    surface.setBusy(row.id, true)
    try {
      const outcome = await api.post(path, body)
      if (!outcome.ok) {
        surface.toast({ id: toastId(), message: conflictMessage(outcome.conflict, t) })
        surface.refresh()
      }
      return outcome
    } finally {
      surface.setBusy(row.id, false)
    }
  }

  return {
    async dismiss(row) {
      // Hidden first, restored if the request fails: a card that lingers for a
      // second after "Dismiss" reads as a button that did not work.
      surface.setHidden(row.id, true)
      if (!(await run(row, `/${row.id}/dismiss`)).ok) {
        surface.setHidden(row.id, false)
        return
      }
      surface.toast({
        id: toastId(),
        message: t('opportunities.toast.dismissed'),
        undoLabel: t('opportunities.toast.undo'),
        onUndo: () => {
          surface.setHidden(row.id, false)
          void api.post(`/${row.id}/restore`).then((outcome) => {
            surface.toast({
              id: toastId(),
              message: outcome.ok
                ? t('opportunities.toast.restored')
                : conflictMessage(outcome.conflict, t),
            })
            surface.refresh()
          })
        },
      })
    },

    async schedule(row) {
      const outcome = await run(row, `/${row.id}/schedule`, {})
      if (!outcome.ok) return
      // The day is the server's answer, not ours: the calendar takes at most
      // one topic a day, so the date asked for and the date given can differ.
      const scheduledFor = (outcome.body as { scheduledFor?: string } | undefined)?.scheduledFor
      if (scheduledFor) {
        surface.toast({
          id: toastId(),
          message: t('opportunities.toast.scheduled', { date: formatDate(scheduledFor) }),
        })
      }
      surface.refresh()
    },

    async generate(row) {
      if ((await run(row, `/${row.id}/recommendations`)).ok) surface.refresh()
    },

    async markTask(row, taskId, state) {
      if ((await run(row, `/${row.id}/tasks/${taskId}`, { state })).ok) surface.refresh()
    },
  }
}

/** The list and detail routes, over the app's own API. */
export function httpOpportunitiesApi(
  base = '/api/opportunities',
  fetchImpl: typeof fetch = fetch,
): OpportunitiesApi {
  async function readJson<T>(path: string): Promise<T | null> {
    try {
      const response = await fetchImpl(`${base}${path}`, { headers: { accept: 'application/json' } })
      if (!response.ok) return null
      return (await response.json()) as T
    } catch {
      return null
    }
  }

  return {
    list: () => readJson<OpportunityListResponse>(''),
    detail: (id) => readJson<OpportunityDetail>(`/${id}`),
    async post(path, body) {
      try {
        const response = await fetchImpl(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
        if (response.ok) return { ok: true, body: await response.json().catch(() => undefined) }
        const payload = (await response.json().catch(() => null)) as
          | { error?: { code?: string } }
          | null
        return { ok: false, conflict: payload?.error?.code ?? null }
      } catch {
        return { ok: false, conflict: null }
      }
    },
  }
}

/** Used by the toast strip; separate so the key list stays in one place. */
export const TOAST_LABEL_KEY: StringKey = 'opportunities.toastLabel'
