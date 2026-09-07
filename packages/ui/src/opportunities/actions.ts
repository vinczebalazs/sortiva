// Type-only, and deliberately so: this module is pulled into a client
// component, and the `@sortiva/core` barrel re-exports domain modules that
// reach for `node:crypto` at import time, which fails the Next build. `typeof`
// over a type-only import still ties these names to the contract's own
// spelling — renaming a code there is a compile error here — and emits nothing.
import type { ConflictCode, ENTITLEMENT_INACTIVE_CODE, RATE_LIMITED_CODE } from '@sortiva/core'
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
 * The sentence for every refusal in the contract's conflict enum. The two
 * refusals that sit outside that enum are below.
 *
 * A refused press comes back with a machine-readable code saying *which*
 * refusal it was — the page was deleted, the day is already taken, we have no
 * permission to write to the store. The point of sending a code rather than a
 * message is that the screen can say the specific thing; for most of the
 * product's life this function knew one code out of twenty-one and answered
 * every other refusal with "this opportunity was updated by the latest scan",
 * which is untrue of almost all of them.
 *
 * Typed against `ConflictCode`, so a code added to the contract with no
 * sentence here is a compile error as well as a named test failure. That
 * belt-and-braces is deliberate: a hand-maintained list is exactly how the
 * missing sentences went unnoticed the first time.
 *
 * Two entries point at copy that already exists rather than at new words.
 * `opportunity_already_updated` really is the generic re-scored case, which is
 * the sentence the interface spec wrote for it; `service_paused` is the pinned
 * outage wording the product may not reword.
 */
export const CONFLICT_MESSAGE_KEYS: Readonly<Record<ConflictCode, StringKey>> = {
  domain_already_claimed: 'opportunities.toast.domainAlreadyClaimed',
  profile_already_confirmed: 'opportunities.toast.profileAlreadyConfirmed',
  opportunity_already_updated: 'opportunities.toast.conflict',
  opportunity_not_open: 'opportunities.toast.notOpen',
  competitor_limit_reached: 'opportunities.toast.competitorLimitReached',
  competitor_is_own_domain: 'opportunities.toast.competitorIsOwnDomain',
  optimize_daily_cap_reached: 'opportunities.toast.optimizeDailyCapReached',
  topic_already_generating: 'opportunities.toast.topicAlreadyGenerating',
  topic_already_published: 'opportunities.toast.topicAlreadyPublished',
  topic_pinned: 'opportunities.toast.topicPinned',
  calendar_day_occupied: 'opportunities.toast.calendarDayOccupied',
  calendar_date_in_past: 'opportunities.toast.calendarDateInPast',
  article_not_in_review: 'opportunities.toast.articleNotInReview',
  article_already_published: 'opportunities.toast.articleAlreadyPublished',
  article_not_rejected: 'opportunities.toast.articleNotRejected',
  refresh_within_cooldown: 'opportunities.toast.refreshWithinCooldown',
  write_scope_required: 'opportunities.toast.writeScopeRequired',
  target_blog_unresolved: 'opportunities.toast.targetBlogUnresolved',
  optimize_page_gone: 'opportunities.toast.pageGone',
  optimize_no_target_query: 'opportunities.toast.noTargetQuery',
  service_paused: 'appendixA.outage',
}

/**
 * The two refusals that reach this function without being conflicts.
 *
 * The browser reads the code off *any* failing response, not only a 409, and
 * the contract has two codes that are deliberately not in the conflict enum:
 * the subscription has lapsed (402) and a rate limit said no (429). Nothing
 * about the resource's state has changed in either case, so keeping them out of
 * that enum is right — but they still land on the same toast, so a table that
 * covers only the enum is a table with two holes in it.
 */
export type NonConflictRefusalCode =
  | typeof ENTITLEMENT_INACTIVE_CODE
  | typeof RATE_LIMITED_CODE

/**
 * `rate_limited` points at the sentence the public preview already shows when
 * it meets the same 429, rather than a second copy of the same words that would
 * eventually drift from it. The preview is the only route the contract marks
 * rate-limited today; this is here so a rate limit put in front of any other
 * route does not arrive as a scan conflict.
 */
export const NON_CONFLICT_REFUSAL_MESSAGE_KEYS: Readonly<
  Partial<Record<NonConflictRefusalCode, StringKey>>
> = {
  rate_limited: 'preview.rateLimited',
}

/**
 * Refusals the contract can return that a merchant is knowingly not being given
 * a sentence for, listed by name so the gap is loud rather than generic.
 *
 * `entitlement_inactive` means the subscription lapsed. Six routes can answer
 * it, two of them buttons on this screen, and today the merchant is told their
 * opportunity was re-scored — which is untrue, and hides the one thing they
 * could act on. Writing what they should read instead is billing copy and is
 * the founder's to write, not this screen's to invent. Recorded here so the
 * exhaustiveness check below stays exhaustive without swallowing it: a *new*
 * code with no sentence still fails, and this one stops being allowed the
 * moment it is given words.
 */
export const REFUSAL_CODES_AWAITING_COPY: readonly NonConflictRefusalCode[] = [
  'entitlement_inactive',
]

/** Every refusal code this screen has a sentence for, conflict or not. */
export const REFUSAL_MESSAGE_KEYS: Readonly<Record<string, StringKey | undefined>> = {
  ...CONFLICT_MESSAGE_KEYS,
  ...NON_CONFLICT_REFUSAL_MESSAGE_KEYS,
}

/**
 * Every one of these ends the same way — the list is re-read — so the message
 * says what happened rather than offering a retry that would race the same way.
 *
 * A code we do not recognise still gets the generic re-scored line rather than
 * nothing: a refusal the frontend has never heard of is much more likely to be
 * a stale build than a new kind of failure, and a merchant should never be left
 * with a button that did nothing and said nothing.
 */
export function conflictMessage(code: string | null, t: Translate = defaultTranslate): string {
  if (code === null) return t('opportunities.toast.failed')
  return t(REFUSAL_MESSAGE_KEYS[code] ?? 'opportunities.toast.conflict')
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
