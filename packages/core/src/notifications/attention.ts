import type { NotificationRefs } from './refs'

/**
 * The dashboard's "needs you" list.
 *
 * It is computed from current state every time it is asked for, and never
 * stored. That is the whole design: the moment a merchant approves the draft,
 * confirms the URL or applies the task, the condition stops being true and the
 * item is gone — with no row to update, no "mark as done" to forget, and no way
 * for the reminder and the thing it reminds about to disagree.
 *
 * The bell is the opposite and deliberately so: "your draft is ready" stays in
 * the history after the draft is approved, because it is a record of something
 * that happened. The two can describe the same event and neither is redundant.
 */

export const ATTENTION_KINDS = [
  'draft_awaiting_review',
  'repair_pending',
  'export_url_unconfirmed',
  'merchant_task',
  'optimize_unapplied',
] as const

export type AttentionKind = (typeof ATTENTION_KINDS)[number]

/** What a source found: which thing, and how long it has been waiting. */
export interface AttentionCandidate {
  readonly refs: NotificationRefs
  readonly since: Date
}

export interface AttentionItem extends AttentionCandidate {
  readonly kind: AttentionKind
}

/**
 * How long an export-mode account has to paste back the address it published
 * our article at before we bring it up. Short enough that the merchant still
 * remembers doing it; long enough not to nag someone who published yesterday.
 */
export const EXPORT_URL_UNCONFIRMED_DAYS = 7

/**
 * How long a generated recommendation sits unapplied before it joins the list.
 * Deliberately double the reminder window above, because this one is a nudge
 * about optional work rather than a gap in our own records — raising it makes
 * the list quieter, lowering it makes it a nag.
 */
export const OPTIMIZE_UNAPPLIED_DAYS = 14

/**
 * One reader per condition. Each is a live read; none of them writes.
 *
 * They are a port rather than five queries here because two of the five sit on
 * tables another lane has not created yet — the binding decides what a source
 * that cannot be read yet does, and this file stays the same either way.
 */
export interface AttentionSources {
  readonly draftsAwaitingReview: (now: Date) => Promise<readonly AttentionCandidate[]>
  readonly pendingRepairs: (now: Date) => Promise<readonly AttentionCandidate[]>
  readonly unconfirmedExportUrls: (now: Date) => Promise<readonly AttentionCandidate[]>
  readonly openMerchantTasks: (now: Date) => Promise<readonly AttentionCandidate[]>
  readonly unappliedOptimizeRecommendations: (now: Date) => Promise<readonly AttentionCandidate[]>
}

const READERS: readonly {
  readonly kind: AttentionKind
  readonly read: keyof AttentionSources
}[] = [
  { kind: 'draft_awaiting_review', read: 'draftsAwaitingReview' },
  { kind: 'repair_pending', read: 'pendingRepairs' },
  { kind: 'export_url_unconfirmed', read: 'unconfirmedExportUrls' },
  { kind: 'merchant_task', read: 'openMerchantTasks' },
  { kind: 'optimize_unapplied', read: 'unappliedOptimizeRecommendations' },
]

/**
 * Ordered by how much the merchant is being asked for: a draft blocking today's
 * publication first, an optional optimisation nudge last. Within a kind the
 * longest-waiting comes first.
 */
export async function buildAttentionList(
  sources: AttentionSources,
  now: Date = new Date(),
): Promise<readonly AttentionItem[]> {
  const found = await Promise.all(READERS.map(({ read }) => sources[read](now)))

  const items: AttentionItem[] = []
  READERS.forEach(({ kind }, index) => {
    const candidates = [...(found[index] ?? [])].sort(
      (a, b) => a.since.getTime() - b.since.getTime(),
    )
    for (const candidate of candidates) items.push({ kind, ...candidate })
  })
  return items
}

/** The moment a window of `days` ago closes, for a source's cutoff. */
export function cutoffDaysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

/** The copy key for each kind, held against the string catalogue by a test. */
export function attentionStringKeys(): readonly string[] {
  return ATTENTION_KINDS.map((kind) => `attention.${camel(kind)}`)
}

function camel(value: string): string {
  return value.replace(/_([a-z])/g, (_whole, letter: string) => letter.toUpperCase())
}
