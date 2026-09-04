import { index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { accounts } from './accounts'

/**
 * The store behind sign-in by email. One row per outstanding magic link.
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
 * The table is ours rather than the spec's data model, which omits it. Added by
 * the mini-wave `T2.0b`
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
    // The retention sweep that clears expired links scans this.
    index('verification_tokens_expires_idx').on(t.expires),
  ],
)

/**
 * ─────────────────── schema mini-wave 5 (`T-WAVE5`) ───────────────────
 *
 * One row per signed-in browser, so a session can be ended before it expires.
 *
 * Until now a session was a self-contained signed cookie: nothing recorded that
 * it existed, so nothing could stop it. A copied cookie stayed good for its
 * whole lifetime and "sign out" only cleared it in the browser that pressed it.
 * A session has to be a row somewhere before anything can delete it, and this is
 * that row. Nothing reads or writes it yet — see `DECISIONS.md`, 2026-09-04
 * ("Sessions become revocable"); the work that uses it is card `R-REVOKE`.
 *
 * **Revocation is deletion, not a flag.** A `revoked_at` column would mean every
 * read on every request also has to test it, and dead rows would live on for
 * their full lifetime; a delete makes the same read a plain hit-or-miss.
 *
 * The shape is chosen for the one query that runs constantly — look a token up,
 * on every signed-in request, on a small database. The token is therefore the
 * primary key itself: the lookup is one index probe straight to the row, with no
 * second column to widen it and no secondary index to bounce through. The two
 * other indexes serve operations that happen once in a while, and cost only a
 * little extra work when a session is created or removed.
 *
 * Column names follow `verification_tokens` above — `expires`, not the house
 * `*_at` suffix — because both tables are read through the same sign-in library,
 * which knows these fields by those names.
 */
export const sessions = pgTable(
  'sessions',
  {
    /**
     * The value the browser presents. Primary key rather than an id column with
     * a unique index beside it: the every-request read is this lookup, and this
     * way it is the cheapest one the database can do.
     */
    sessionToken: text('session_token').primaryKey(),
    /**
     * Whose session it is. The cascade is half of "deleting an account locks it
     * out immediately" — removing the account takes its sessions with it, in the
     * same statement, rather than leaving live cookies behind a deleted row.
     */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** When the session lapses on its own, with nobody having ended it. */
    expires: timestamp('expires', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // "Sign out everywhere" and account deletion both delete every row for one
    // account. Without this they read the whole table.
    index('sessions_account_id_idx').on(t.accountId),
    // The sweep that clears lapsed sessions, the same way expired sign-in links
    // are cleared above. Included now because migrations only land in schema
    // waves, so an index left out here cannot be added when the sweep is built.
    index('sessions_expires_idx').on(t.expires),
  ],
)
