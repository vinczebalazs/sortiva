import { topicFingerprint } from './fingerprint'

/**
 * Main §8.7: "deleted topics go to a 'not interested' list that replenishment
 * consults, so a vetoed topic is never re-proposed." The consult itself -
 * real replenishment candidate-scoring is T4.6's, not built yet, but the
 * primitive it will call is this: given a batch of candidates and the
 * account's `not_interested` fingerprints, which candidates survive.
 */
export function excludeNotInterested<T extends { readonly searchTerm: string }>(
  candidates: readonly T[],
  fingerprints: ReadonlySet<string>,
): readonly T[] {
  return candidates.filter((candidate) => !fingerprints.has(topicFingerprint(candidate.searchTerm)))
}
