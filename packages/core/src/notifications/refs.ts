/**
 * What a stored notification is allowed to contain: identifiers, and nothing
 * else.
 *
 * The display sentence is produced when the bell is rendered, by looking the
 * referenced thing up. That is what lets copy be reworded or translated without
 * rewriting history, and what makes a deleted entity degrade to a generic line
 * instead of showing a title that is no longer true.
 *
 * It is also a containment boundary. Article text, product descriptions and
 * merchant-written copy are the things this product must not spread into places
 * they were never meant to reach — notification rows, and from there anything
 * that reads them. A rule stated in a comment does not hold; this one is checked
 * on the way in, so a caller that passes a headline gets an error rather than a
 * stored sentence.
 */

export type NotificationRefs = Readonly<Record<string, string>>

/** Snake-case identifiers, so a payload's keys read like column names. */
const REF_KEY = /^[a-z][a-z0-9_]{0,63}$/

/**
 * A reference has no spaces and no punctuation that only prose needs. Ids,
 * slugs, handles, ISO weeks and `YYYY-MM` periods all pass; a sentence cannot,
 * because it contains a space long before it reaches the length cap.
 */
const REF_VALUE = /^[A-Za-z0-9_.:@+/-]{1,128}$/

export class NotificationPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotificationPayloadError'
  }
}

/**
 * Throws unless every entry is a reference. Called by the emitter before the
 * insert, so nothing reaches the table without passing.
 */
export function assertReferenceOnly(refs: NotificationRefs): void {
  for (const [key, value] of Object.entries(refs)) {
    if (!REF_KEY.test(key)) {
      throw new NotificationPayloadError(
        `Notification payload key "${key}" is not an identifier. Payloads hold references only — ` +
          `name the thing (\`article_id\`), never the words.`,
      )
    }
    if (typeof value !== 'string' || !REF_VALUE.test(value)) {
      throw new NotificationPayloadError(
        `Notification payload "${key}" is not a reference. Payloads hold ids and short tokens; ` +
          `display text is produced when the notification is rendered, never stored.`,
      )
    }
  }
}

/** The non-throwing form, for a caller that wants to decide what to do. */
export function isReferenceOnly(refs: NotificationRefs): boolean {
  try {
    assertReferenceOnly(refs)
    return true
  } catch {
    return false
  }
}
