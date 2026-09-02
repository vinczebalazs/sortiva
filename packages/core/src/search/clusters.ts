import type { ClustersConfig } from '@sortiva/rules'

/**
 * Pooling the many ways people phrase one thing into a single intent.
 *
 * A store is not shown for "waterproof hiking boots" — it is shown for that,
 * and "hiking boots waterproof", and "best waterproof hiking boots", and forty
 * more spellings, each with a handful of impressions. Judged one spelling at a
 * time, none of them is worth acting on and two of the store's own pages
 * splitting the same intent between them is invisible. Pooled, both become
 * obvious. That pool is a cluster: a head search plus the near-variants of it
 * the store is actually shown for.
 *
 * The grouping rule is deliberately narrow: a search joins a head only when it
 * contains every one of the head's meaningful words. That never merges two
 * unrelated intents, which is the failure that matters — two unrelated searches
 * pooled together would show two pages "competing" that have nothing to do with
 * each other, and the merchant would be told to consolidate pages that should
 * stay apart. The opposite failure, a variant left in a cluster of its own, only
 * costs us a signal we might have found.
 *
 * Containment alone is not enough, because "shoes" contains "running shoes" and
 * those are not one intent. Two rules separate them. A search with exactly the
 * head's words in another order, or with a filler word added, is always the same
 * intent and always folds in. A search that adds a real word keeps its own
 * cluster if the store is shown for it often enough to be worth acting on
 * separately, and folds in otherwise — the threshold for "often enough" lives in
 * `packages/rules`.
 */

/** One search over the window, already totalled. */
export interface ClusterQueryInput {
  readonly query: string
  readonly clicks: number
  readonly impressions: number
}

export interface ClusterDraft {
  readonly headQuery: string
  /** The near-variants pooled into this head, most-shown first. Excludes the head itself. */
  readonly memberQueries: readonly string[]
  readonly impressions: number
  readonly clicks: number
}

export interface BuildQueryClustersInput {
  readonly queries: readonly ClusterQueryInput[]
  readonly config: ClustersConfig
  /**
   * Searches the merchant confirmed during onboarding. Where one of these
   * matches a search the store is shown for, it is preferred as the head, so the
   * cluster a topic descends from is named the way the merchant named it.
   */
  readonly preferredHeads?: readonly string[]
}

/**
 * Words that carry no intent of their own. Removing them is what lets "shoes for
 * running" and "running shoes" reach the same head; leaving them in would make
 * the containment test depend on how a person phrased a question.
 *
 * English only, which is a real limit: a Danish or Hungarian store's searches
 * keep their function words and cluster slightly less tightly than an English
 * store's. It costs recall, never correctness — an unremoved word can only keep
 * two searches apart, never push two unrelated ones together.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'best',
  'by',
  'can',
  'do',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'my',
  'of',
  'on',
  'or',
  'the',
  'to',
  'top',
  'vs',
  'what',
  'where',
  'which',
  'with',
  'you',
  'your',
])

/** Lowercased, punctuation dropped, accents kept — "café" and "cafe" are different searches to Google and to us. */
export function normaliseQuery(query: string): string {
  return query.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** The words that decide what a search is about, in no particular order. */
export function contentTokens(query: string): string[] {
  const words = normaliseQuery(query).split(' ').filter(Boolean)
  const kept = words.filter((word) => !STOPWORDS.has(word))
  // A search made entirely of function words still has to be about something,
  // so fall back to every word rather than to nothing.
  return kept.length > 0 ? kept : words
}

function subsumes(head: readonly string[], candidate: ReadonlySet<string>): boolean {
  return head.every((token) => candidate.has(token))
}

/**
 * Builds the clusters for one store from the searches it was actually shown for.
 *
 * Searches are walked busiest-first, so the phrasing that names a cluster is the
 * one the store is most often shown for. Each search either starts a cluster or
 * joins the **most specific** existing one that contains it — which is what
 * keeps "trail running shoes" with "running shoes" rather than with "shoes".
 */
export function buildQueryClusters(input: BuildQueryClustersInput): ClusterDraft[] {
  const { config } = input

  const eligible = input.queries
    .filter((row) => row.impressions >= config.min_query_impressions)
    .map((row) => {
      const tokens = contentTokens(row.query)
      return {
        ...row,
        normalized: normaliseQuery(row.query),
        tokens,
        signature: [...tokens].sort().join(' '),
      }
    })
    .filter((row) => row.normalized.length > 0)

  const preferred = new Set((input.preferredHeads ?? []).map(normaliseQuery).filter(Boolean))

  // Busiest first, so the head of a cluster is the phrasing the store is most
  // often shown for. A merchant-confirmed search wins ahead of that, because it
  // is what the merchant will recognise on screen.
  const byPriority = [...eligible].sort((a, b) => {
    const aPreferred = preferred.has(a.normalized) ? 1 : 0
    const bPreferred = preferred.has(b.normalized) ? 1 : 0
    if (aPreferred !== bPreferred) return bPreferred - aPreferred
    if (a.impressions !== b.impressions) return b.impressions - a.impressions
    return a.normalized.localeCompare(b.normalized)
  })

  interface Head {
    readonly signature: string
    readonly display: string
    readonly tokens: readonly string[]
    readonly members: { query: string; impressions: number }[]
    clicks: number
    impressions: number
  }

  const heads: Head[] = []
  const seen = new Set<string>()

  for (const row of byPriority) {
    if (seen.has(row.normalized)) continue
    seen.add(row.normalized)

    // Most specific first, so a search both a narrow and a broad head could take
    // goes to the narrow one. Without this, "shoes" absorbs "running shoes" and
    // every conclusion drawn from that cluster is about nothing in particular.
    const containing = heads
      .filter((head) => subsumes(head.tokens, new Set(row.tokens)))
      .sort((a, b) => b.tokens.length - a.tokens.length)
    const host = containing[0]

    // The same words in a different order, or with a filler word added, is the
    // same search. It folds into its head however often it is shown — splitting
    // "linen bedding" from "best linen bedding" would have the store competing
    // with itself on the strength of the word "best".
    const sameIntent = host?.signature === row.signature

    // A narrower search that is substantial on its own keeps its own cluster:
    // people searching "running shoes" want something different from people
    // searching "shoes", and pooling them would hide both.
    const standsAlone =
      !sameIntent && row.tokens.length >= config.head_min_tokens && row.impressions >= config.head_min_impressions

    if (host && !standsAlone) {
      if (host.members.length >= config.max_member_queries) continue
      host.members.push({ query: row.query, impressions: row.impressions })
      host.clicks += row.clicks
      host.impressions += row.impressions
      continue
    }

    if (heads.length >= config.max_clusters) continue
    if (row.tokens.length < config.head_min_tokens) continue
    heads.push({
      signature: row.signature,
      display: row.query,
      tokens: row.tokens,
      members: [],
      clicks: row.clicks,
      impressions: row.impressions,
    })
  }

  return heads.map((head) => ({
    headQuery: head.display,
    memberQueries: [...head.members]
      .sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query))
      .map((member) => member.query),
    impressions: head.impressions,
    clicks: head.clicks,
  }))
}

/**
 * Which cluster a single search belongs to, given clusters already built. Used
 * when Search Console reports a search we have seen before and detection needs
 * to attribute it without rebuilding everything.
 */
export function clusterKeyFor(
  query: string,
  clusters: ReadonlyArray<{ headQuery: string; memberQueries: readonly string[] }>,
): string | null {
  const normalized = normaliseQuery(query)
  for (const cluster of clusters) {
    if (normaliseQuery(cluster.headQuery) === normalized) return cluster.headQuery
    if (cluster.memberQueries.some((member) => normaliseQuery(member) === normalized)) {
      return cluster.headQuery
    }
  }
  return null
}
