import { generateSyntheticStore } from '@sortiva/core'
import pg from 'pg'

/**
 * Seeds a development or Playwright database with one account whose store is a
 * deterministic synthetic catalog, for the browser tests to run against.
 *
 * Deterministic on purpose: a UI test that asserts "4 families" must get the
 * same four families on every run, or it is a flake generator.
 *
 * Only wave-1 tables exist, so this seeds the account, its settings and its
 * claimed domain. The catalog rows themselves land when schema wave 2 adds
 * `products` and `product_families` (T2.0); the generator that produces them is
 * already here and is what those rows will be built from.
 */

export const SEED_EMAIL = 'dev@sortiva.test'
export const SEED_DOMAIN = 'example-outdoor.com'

export interface SeedResult {
  accountId: string
  domain: string
  /** What the catalog will hold once wave 2 lands, so a test can assert against it today. */
  expected: { products: number; families: number; pages: readonly string[] }
}

export async function seedDevDatabase(connectionString = process.env.DATABASE_URL): Promise<SeedResult> {
  if (!connectionString) throw new Error('DATABASE_URL is not set')
  const pool = new pg.Pool({ connectionString })

  try {
    const store = generateSyntheticStore({ seed: 1, domain: SEED_DOMAIN })

    const account = await pool.query<{ id: string }>(
      `INSERT INTO accounts (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [SEED_EMAIL],
    )
    const accountId = account.rows[0]!.id

    await pool.query(
      `INSERT INTO account_settings (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING`,
      [accountId],
    )

    // Invariant 1 — the claim is an insert-with-conflict, never check-then-insert,
    // and this seed goes through the same door.
    await pool.query(
      `INSERT INTO domains (account_id, domain_normalized, platform, state)
       VALUES ($1, $2, 'shopify', 'ready_for_planning')
       ON CONFLICT (domain_normalized) DO NOTHING`,
      [accountId, SEED_DOMAIN],
    )

    return {
      accountId,
      domain: SEED_DOMAIN,
      expected: {
        products: store.products.length,
        families: store.families.length,
        pages: store.pages,
      },
    }
  } finally {
    await pool.end()
  }
}
