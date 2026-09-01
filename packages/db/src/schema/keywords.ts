import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  boolean,
} from 'drizzle-orm/pg-core'
import { accounts } from './accounts'
import { discoverySourceEnum } from './enums'

/**
 * main §13 `keywords`, §6.6, §12.1.
 *
 * Seed terms derived from the persona and product families, then enriched
 * through DataForSEO using the persona's language and country as the location
 * parameters. `confirmed` is the merchant's decision at the confirmation screen
 * (§6.8); `enriched_at` is what the 30-day metric cache (§12.1) is judged against.
 */
export const keywords = pgTable(
  'keywords',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    term: text('term').notNull(),
    language: text('language').notNull(),
    country: text('country').notNull(),
    volume: integer('volume'),
    difficulty: integer('difficulty'),
    cpc: numeric('cpc', { precision: 10, scale: 4 }),
    source: discoverySourceEnum('source').notNull(),
    enrichedAt: timestamp('enriched_at', { withTimezone: true }),
    confirmed: boolean('confirmed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('keywords_account_term_key').on(t.accountId, t.term),
    index('keywords_account_confirmed_idx').on(t.accountId, t.confirmed),
  ],
)

/**
 * main §13 `competitors`, §6.6, §7.2.1. Constitution invariant 5.
 *
 * **Business** competitors only, and at most five per account. §6.6: "the cap is
 * enforced in the API and DB (application-level check + count constraint), not
 * just the UI, because competitor count directly drives DataForSEO cost".
 *
 * The count constraint is a trigger, not anything drizzle can express — see
 * `migrations/0003_wave2_guards.sql`, which is where a sixth row is refused.
 *
 * Query-level SERP competitors are a separate, uncapped, non-editable concept
 * that lives inside `serp_snapshots` (§12.6) and is never copied here. They may
 * be *suggested* to the merchant, never auto-added.
 */
export const competitors = pgTable(
  'competitors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** PSL-normalised eTLD+1, the same normalisation as `domains` (main §2). */
    domainNormalized: text('domain_normalized').notNull(),
    source: discoverySourceEnum('source').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('competitors_account_domain_key').on(t.accountId, t.domainNormalized)],
)
