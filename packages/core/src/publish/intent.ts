/**
 * The rule that stops a crash from posting an article twice.
 *
 * Writing to somebody else's shop is the one act in this product that cannot be
 * taken back by retrying more carefully. Every other external call is either a
 * read, which can be repeated, or a purchase, which can be cached. A blog post
 * that goes out twice is two posts a merchant has to delete, and the queue that
 * carries our work promises to deliver a message *at least* once — so the
 * second delivery is not a rare fault, it is the normal case eventually.
 *
 * The protocol, in three steps and a sweep:
 *
 *  1. **Intent.** Before anything is sent, a row is written claiming this
 *     publication. The claim is unique, so a second worker attempting the same
 *     publication collides and stops rather than racing.
 *  2. **Execute.** The article is posted carrying our own marker, so the remote
 *     copy is identifiable as ours by looking at the shop.
 *  3. **Confirm.** The remote id is written back against the claim.
 *
 * A crash can land between any two of those. The sweep is what makes that
 * survivable: before ever sending again, it *asks the shop* whether an article
 * carrying our marker is already there. Found means the post landed and only
 * our record of it was lost — adopt it. Not found means the post never landed —
 * send it. There is no third case, and no path re-sends without having asked.
 */

/**
 * The marker written into the remote article, and the name of the claim.
 *
 * Derived from the article's own id, so a retry of the same publication
 * computes the same marker; a random one would make the shop unsearchable for
 * exactly the article we needed to find.
 */
export function publishMarker(articleId: string): string {
  return `sortiva-${articleId}`
}

/**
 * The claim's name for one revision of one article.
 *
 * A republication — a repair, a refresh — is a separate act needing its own
 * claim, because the first claim is already confirmed and would otherwise stop
 * it. Revision 0 carries the plain marker so the first publication's claim and
 * the marker on the shop are the same string.
 */
export function intentExternalId(articleId: string, revisionN: number): string {
  const marker = publishMarker(articleId)
  return revisionN === 0 ? marker : `${marker}#r${revisionN}`
}

/**
 * How long a claim may sit unconfirmed before the sweep treats it as
 * interrupted rather than in flight.
 *
 * Ten minutes because a publication that is genuinely still running has not
 * taken ten minutes: the sweep must not go looking at a claim a live worker is
 * still holding, or two workers end up sending the same article between them.
 */
export const RECOVERY_GRACE_MS = 10 * 60 * 1000

/** The sweep's own cadence. Named here because the give-up rule below is counted in sweeps. */
export const RECOVERY_INTERVAL_MS = 5 * 60 * 1000

/** Three attempts at recovery, and then a human looks at it rather than a machine trying for ever. */
export const RECOVERY_MAX_ATTEMPTS = 3

/**
 * When a claim stops being recoverable.
 *
 * Counted from the claim's age rather than from a stored attempt counter,
 * because `publish_intents` has no column for one and a feature card may not
 * add a migration. Under a five-minute sweep the two are the same number: the
 * first look happens at ten minutes, and three failed looks put the claim at
 * twenty-five. Recorded in `DECISIONS.md`.
 */
export const RECOVERY_ABANDON_AFTER_MS =
  RECOVERY_GRACE_MS + RECOVERY_MAX_ATTEMPTS * RECOVERY_INTERVAL_MS

export type RecoveryAction =
  /** Too young to touch: a worker may still be holding it. */
  | { readonly action: 'wait' }
  /** The post landed; only our record of it was lost. Write the id down and confirm. */
  | { readonly action: 'adopt'; readonly remoteArticleId: string }
  /** The post never landed. Send it. */
  | { readonly action: 'execute' }
  /** Long past recovering. Stop trying and raise it for a person. */
  | { readonly action: 'abandon' }

export interface RecoveryInput {
  /** How long the claim has been unconfirmed. */
  readonly ageMs: number
  /**
   * The remote article carrying this claim's marker, if the shop has one.
   * `undefined` means we asked and the shop said no — never "we did not ask".
   */
  readonly remoteArticleId: string | undefined
}

/**
 * The sweep's whole decision, as a function of two facts.
 *
 * Adopting comes before abandoning on purpose: an article that is demonstrably
 * on the merchant's shop is a success whose paperwork was lost, however old the
 * claim is, and abandoning it would leave a live post that nothing in the
 * product knows about.
 */
export function recoveryDecision(input: RecoveryInput): RecoveryAction {
  if (input.ageMs < RECOVERY_GRACE_MS) return { action: 'wait' }
  if (input.remoteArticleId) return { action: 'adopt', remoteArticleId: input.remoteArticleId }
  if (input.ageMs >= RECOVERY_ABANDON_AFTER_MS) return { action: 'abandon' }
  return { action: 'execute' }
}

/**
 * The metafield the marker is written into: Shopify's own place for data that
 * belongs to an app rather than to the merchant's content.
 *
 * It is the only marker. The same value used to be written as a tag as well,
 * because a tag travels in a plain list response and a metafield has to be
 * asked for separately — but a tag is the merchant's own vocabulary, shown in
 * their admin and capable of appearing in a storefront tag list their shoppers
 * see. Nothing we add to a merchant's shop should be visible to their
 * customers, so the tag is gone and the extra request is the price of that.
 */
export const PUBLISH_MARKER_NAMESPACE = 'sortiva'
export const PUBLISH_MARKER_KEY = 'external_id'

/**
 * The article a claim belongs to, back out of its name.
 *
 * The recovery sweep works from claims rather than from articles — it starts
 * from "what did we say we were doing?" — and still has to move the article
 * when it finishes one. Returns undefined for anything that is not one of our
 * claim names rather than guessing at an id.
 */
export function articleIdFromIntentExternalId(externalId: string): string | undefined {
  const match = /^sortiva-([0-9a-fA-F-]{36})(?:#r\d+)?$/.exec(externalId)
  return match?.[1]
}

/** Which revision a claim names. Revision 0 is the first publication. */
export function revisionFromIntentExternalId(externalId: string): number {
  const match = /#r(\d+)$/.exec(externalId)
  return match?.[1] ? Number(match[1]) : 0
}
