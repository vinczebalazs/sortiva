import { pageClusterShares, type ClusterDefinition, type ClusterShareRow } from '../search/shares'
import { normalisePageUrl } from '../signals/types'

/**
 * The search a page recommendation is written against.
 *
 * Three of the four detections that put a store page on this path found it by
 * looking at what the page is searched for, and record that search. The fourth —
 * a page whose search listing is missing or shared with another page — is found
 * by reading the store's own catalogue, and records no search at all, because
 * none was involved in finding it.
 *
 * There used to be a fallback for that case: the page's own web address stood in
 * for the search. It bought a results page for
 * `https://store.example/collections/boots` as though a shopper had typed that,
 * told the writing model it was the search, and measured keyword stuffing
 * against the words in a URL. Substituting an address for a search is the
 * failure, and a narrower substitution would only repeat it more quietly, so
 * there is no fallback here at all: either a real search resolves, or the caller
 * refuses to make the recommendation.
 */

/** The evidence keys a detection records a search under, best first. */
const QUERY_KEYS = ['query_cluster', 'query', 'keyword'] as const

/**
 * The search the detection itself recorded, if it recorded one.
 *
 * Null is the ordinary answer for the listing detection and must be treated as
 * "we do not know", never as "use whatever else is to hand".
 */
export function targetQueryFromEvidence(evidence: unknown): string | null {
  if (!Array.isArray(evidence)) return null
  const facts = evidence as readonly { key?: unknown; value?: unknown }[]
  for (const key of QUERY_KEYS) {
    const found = facts.find((fact) => fact.key === key)
    if (found && typeof found.value === 'string' && found.value.trim() !== '') {
      return found.value.trim()
    }
  }
  return null
}

export interface ResolveTargetQueryInput {
  /** The page being improved. */
  readonly pageUrl: string
  /** The store's intents as they were last pooled. */
  readonly clusters: readonly ClusterDefinition[]
  /** Page-by-search totals over the window the clusters were built from. */
  readonly rows: readonly ClusterShareRow[]
}

/**
 * The intent this page is most shown for, out of the intents the store already
 * has — not a new search, and nothing derived from the page's address.
 *
 * "Most shown for" is impressions on this page across every spelling in the
 * cluster. A page that appears in three intents gets the one it holds most of,
 * because that is the one an edit to its listing has the most to move. Ties go
 * to the alphabetically first head so two runs on the same data agree.
 *
 * Null when no cluster of the store's covers this page at all — a store with no
 * Search Console connection, a page nobody has been shown for, or a page whose
 * searches all sit under the noise floor clustering applies.
 */
export function resolveTargetQueryFromClusters(input: ResolveTargetQueryInput): string | null {
  const wanted = normalisePageUrl(input.pageUrl)
  const mine = input.rows.filter((row) => normalisePageUrl(row.page) === wanted)
  if (mine.length === 0 || input.clusters.length === 0) return null

  // Rows are already narrowed to this page, so each cluster carries at most one
  // page share, and that share is this page's standing in that intent. A
  // cluster with none is one this page has never been shown for.
  const shares = pageClusterShares(input.clusters, mine)
  let best: { head: string; impressions: number } | null = null
  for (const share of shares) {
    const ours = share.pages[0]
    if (!ours) continue
    if (
      best === null ||
      ours.impressions > best.impressions ||
      (ours.impressions === best.impressions && share.headQuery.localeCompare(best.head) < 0)
    ) {
      best = { head: share.headQuery, impressions: ours.impressions }
    }
  }

  return best?.head ?? null
}
