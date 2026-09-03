/**
 * The `not_interested` list's key, main §8.7: "deleted topics go to a
 * 'not interested' list that replenishment consults, so a vetoed topic is
 * never re-proposed."
 *
 * Normalised the same way every other entity-identity string in this codebase
 * is (`admit-manual-topic.ts`'s `normaliseEntityRef`, the opportunity dedupe
 * key): trimmed and lower-cased, so "Trail Running Shoes" and "trail running
 * shoes " are the same fingerprint. Keyed on the search term rather than the
 * topic's own id, because the id changes every time the topic is re-proposed —
 * the whole point is recognising the *same candidate* coming back.
 */
export function topicFingerprint(searchTerm: string): string {
  return searchTerm.trim().toLowerCase()
}
