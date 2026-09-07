import { normalisePageUrl, type Logger } from '@sortiva/core'
import {
  accountScope,
  expireOpportunity,
  goneStorePageUrls,
  listOpenOpportunities,
  type Db,
  type OpportunityRow,
} from '@sortiva/db'
import { runtimeLogger } from '../runtime/logging'

/**
 * Taking down the suggestions about pages the store no longer serves.
 *
 * A suggestion names one page and asks the merchant to improve it. Once that
 * page is deleted there is nothing to improve and nothing to apply advice to,
 * so leaving the card up asks them to keep deciding about something that does
 * not exist — and every press now refuses. The founder's answer was that the
 * suggestion goes when the page goes.
 *
 * It closes rather than deletes: the row is the only record that we ever
 * suggested this, and the learning loop reads closed rows. It is also what
 * keeps a re-detection from stacking up: the row leaves the open set, so a
 * page the merchant puts back gets one fresh suggestion at the next scan
 * rather than a second one beside the old.
 *
 * Nothing here brings a suggestion back. A restored page is found by the walk,
 * its row goes back to live, and the next scan detects the signal again on its
 * own — the same way the improve-this-page button starts working again with
 * nothing run for it.
 */

/**
 * The statuses a deleted page's suggestion may be closed out of.
 *
 * Deliberately short of the full open set. A `scheduled` or `executing` row has
 * been taken over by machinery elsewhere — a calendar day, or a recommendation
 * being generated — and reaching in to expire it from here would strand the
 * work that owns it. Those rows come back to one of these three when that work
 * finishes or refuses, and the next walk closes them then.
 */
const CLOSEABLE: readonly OpportunityRow['status'][] = ['new', 'accepted', 'blocked']

export interface CloseGoneSuggestionsDeps {
  readonly db: Db
  readonly now?: () => Date
  readonly logger?: Logger
}

export interface CloseGoneSuggestionsResult {
  /** Suggestions taken down on this pass. */
  readonly closed: number
}

/**
 * Called only after a walk that reached the end of the store, because that is
 * the only thing that makes a page's absence mean anything — the same rule that
 * governs when a page may be marked gone at all.
 */
export async function closeSuggestionsForGonePages(
  deps: CloseGoneSuggestionsDeps,
  accountId: string,
): Promise<CloseGoneSuggestionsResult> {
  const log = deps.logger ?? runtimeLogger()
  const scope = accountScope(accountId)
  const now = (deps.now ?? (() => new Date()))()

  // Only a suggestion whose subject *is* a page can be about a page that went.
  // The rest are keyed on a search, a range of products or an article of ours,
  // none of which an address can answer for.
  const open = (await listOpenOpportunities(deps.db, scope)).filter(
    (row) => row.entityType === 'url' && CLOSEABLE.includes(row.status),
  )
  if (open.length === 0) return { closed: 0 }

  const gone = new Set((await goneStorePageUrls(deps.db, scope)).map(normalisePageUrl))
  if (gone.size === 0) return { closed: 0 }

  let closed = 0
  for (const row of open) {
    if (!gone.has(normalisePageUrl(row.entityRef))) continue
    const expired = await expireOpportunity(deps.db, scope, row.id, 'entity_deleted', now, CLOSEABLE)
    // Somebody moved the row between the read above and this write. Whatever
    // they did with it is more recent than this pass's picture of it, so this
    // stops rather than overwriting a decision it did not make.
    if (!expired) continue
    closed += 1
    log.info('opportunity_closed_page_gone', {
      account_id: accountId,
      opportunity_id: row.id,
      signal_type: row.signalType,
      recommended_action: row.recommendedAction,
      from: row.status,
    })
  }

  return { closed }
}
