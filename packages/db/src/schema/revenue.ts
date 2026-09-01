import { date, index, integer, numeric, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import { accounts } from './accounts'

/**
 * Shopify order landing pages, aggregated per day per URL.
 *
 * V1 captures this and shows nothing: attributing revenue to an article on a
 * few weeks of data would be fake precision, and worse than showing clicks.
 * Capturing now means the history exists when it can be read honestly.
 *
 * Customer fields are stripped at read time, before
 * anything is written. As with `top_products`, the rule shows up here as an
 * absence — there is no column an email, name, address or order id could go in,
 * which is what makes the GDPR customer webhooks' "no data held" answer
 * literally true rather than a claim we would have to check.
 */
export const landingRevenueDaily = pgTable(
  'landing_revenue_daily',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    landingUrl: text('landing_url').notNull(),
    ordersN: integer('orders_n').notNull().default(0),
    revenue: numeric('revenue', { precision: 14, scale: 2 }).notNull().default('0'),
    currency: text('currency').notNull(),
  },
  (t) => [
    primaryKey({
      name: 'landing_revenue_daily_pk',
      columns: [t.accountId, t.date, t.landingUrl],
    }),
    index('landing_revenue_daily_account_date_idx').on(t.accountId, t.date),
  ],
)
