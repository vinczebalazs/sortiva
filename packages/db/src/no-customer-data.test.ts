import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { databaseAvailable, setupTestDb, type TestDb } from './testing'

/**
 * Invariant 4 — "Order ingestion strips all customer fields at read time; only
 * line-item / landing-page aggregates are persisted. **A test asserts no
 * customer field reaches storage.** GDPR customer webhooks answer 'no data
 * held'."
 *
 * That test did not exist. The protection was two prose comments saying the rule
 * "shows up here as an absence" — and an absence nothing checks is an absence
 * until someone adds a column. Adding `customer_email` and `shipping_city` to the
 * order-derived table, with its migration, passed 433 tests and lint
 * (`docs/audits/false-confidence.md`, finding 2).
 *
 * This asks the live database what columns it actually has, rather than reading
 * the schema files — a migration is what creates a column, and a migration can
 * add one the schema files do not obviously show.
 *
 * The promise is specifically about **the merchant's customers**: the shoppers who
 * buy from the store. It is not about the merchant, who is our own customer and
 * whose email we plainly hold. Hence the allowlist, which is short on purpose and
 * carries a reason per entry. Adding to it should feel like a decision.
 */

const CUSTOMER_WORDS = new Set([
  'email',
  'phone',
  'telephone',
  'name',
  'address',
  'city',
  'postcode',
  'postal',
  'zip',
  'customer',
  'recipient',
  'buyer',
  'shopper',
  'shipping',
  'firstname',
  'lastname',
  'ip',
])

/**
 * Matches whole underscore-delimited words, not substrings. A substring match
 * flags `limited_intelligence` because "intelligence" contains "tel", and a rule
 * that cries wolf gets an allowlist entry rather than a fix.
 */
function looksLikeCustomerField(columnName: string): boolean {
  return columnName.split('_').some((word) => CUSTOMER_WORDS.has(word))
}

/** Every entry is a merchant-level or product-level field, never a shopper's. */
const ALLOWED: Record<string, string> = {
  'accounts.email': "the merchant's own login address — our customer, not theirs",
  'accounts.stripe_customer_id': "Stripe's id for the merchant's billing account",
  'email_suppressions.email': 'an address that bounced, so we stop mailing it',
  'deletion_confirmation_emails.email':
    "the merchant's own address — captured at send time because the account row it would otherwise be read from is erased about a week later",
  'notification_prefs.email_article_published': 'a preference flag; "email" is the channel',
  'notification_prefs.email_digest_frequency': 'a preference flag; "email" is the channel',
  'product_families.name': "a product family's name, e.g. 'trail running shoes'",
}

const available = await databaseAvailable()

describe.skipIf(!available)('invariant 4 — no customer field reaches storage', () => {
  let ctx: TestDb

  beforeAll(async () => {
    ctx = await setupTestDb('no_customer_data')
  }, 60_000)

  afterAll(async () => {
    await ctx?.close()
  })

  it('holds no column that could carry a shopper identity', async () => {
    const { rows } = await ctx.pool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'public'
        order by table_name, column_name`,
    )

    // If this scan ever sees nothing, it would pass by doing nothing.
    expect(rows.length, 'the column scan found no columns at all').toBeGreaterThan(100)

    const offenders = rows
      .map((r) => `${r.table_name}.${r.column_name}`)
      .filter((qualified) => looksLikeCustomerField(qualified.split('.')[1]!))
      .filter((qualified) => !(qualified in ALLOWED))

    expect(
      offenders,
      `These columns could hold one of the merchant's customers. Invariant 4 says we hold ` +
        `none, which is what lets the GDPR webhooks answer "no data held" truthfully. If one ` +
        `of these is genuinely merchant-level or product-level, add it to ALLOWED with the ` +
        `reason: ${offenders.join(', ')}`,
    ).toEqual([])
  })

  it('keeps the allowlist honest: every entry still exists', async () => {
    // An allowlist that outlives its columns is a place for a new one to hide.
    const { rows } = await ctx.pool.query<{ qualified: string }>(
      `select table_name || '.' || column_name as qualified
         from information_schema.columns where table_schema = 'public'`,
    )
    const present = new Set(rows.map((r) => r.qualified))
    const stale = Object.keys(ALLOWED).filter((entry) => !present.has(entry))
    expect(stale, `allowlist entries with no column behind them: ${stale.join(', ')}`).toEqual([])
  })

  it('the rule is not vacuous: a planted customer column would be caught', () => {
    const planted = ['top_products.customer_email', 'landing_revenue_daily.shipping_city']
    const caught = planted.filter(
      (q) => looksLikeCustomerField(q.split('.')[1]!) && !(q in ALLOWED),
    )
    expect(caught).toEqual(planted)
  })
})

describe('database availability (invariant 4 suite)', () => {
  it('reports whether the customer-data scan actually ran', () => {
    if (!available) {
      throw new Error(
        'No Postgres at the test URL. The no-customer-data scan cannot be skipped silently — ' +
          'run `pnpm db:up` first.',
      )
    }
    expect(available).toBe(true)
  })
})
