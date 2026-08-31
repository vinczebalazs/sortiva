import { index, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

/**
 * The store behind sign-in by email (main §4.1 — "standard email + OAuth
 * (Google) signup"). One row per outstanding magic link.
 *
 * Card `T1.1` shipped Google-only sign-in and recorded this table's absence as
 * a blocker rather than working around it (DECISIONS 2026-08-31 T1.1). The
 * mechanism it blocks: Auth.js refuses to start an email provider without an
 * adapter exposing `createVerificationToken` / `useVerificationToken`, and both
 * are row operations on exactly this shape. The row is deleted the instant the
 * link is followed, and *that deletion* is the single-use guarantee — the
 * alternative T1.1 rejected, a self-contained signed link, stays valid until it
 * expires, so a forwarded copy or a corporate mail scanner's prefetch can spend
 * it a second time.
 *
 * main §13 does not list this table; it is the one thing §4.1 requires that the
 * data model omits. Added by the mini-wave `T2.0b`
 * (`docs/audits/remediation.md` D7 item 1).
 *
 * Column names are Auth.js's, not this repository's: `expires`, not the house
 * `*_at` suffix. The adapter reads them by name.
 *
 * No foreign key to `accounts`: `identifier` is the email address a link was
 * sent to, and a first-time visitor has no account row until the link is
 * followed.
 */
export const verificationTokens = pgTable(
  'verification_tokens',
  {
    /** The address the link was sent to. Not an account reference — see above. */
    identifier: text('identifier').notNull(),
    /** The link's secret. Single-use by deletion, not by a consumed flag. */
    token: text('token').notNull(),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'verification_tokens_pk', columns: [t.identifier, t.token] }),
    // A secret that opened two mailboxes would be two live links, which is the
    // one thing this table exists to prevent.
    uniqueIndex('verification_tokens_token_key').on(t.token),
    // The sweep that clears expired links (tech §2.1 retention) scans this.
    index('verification_tokens_expires_idx').on(t.expires),
  ],
)
