#!/usr/bin/env node
/**
 * `pnpm comp list` / `pnpm comp grant <email|domain> --actor <you> --reason "<why>"` /
 * `pnpm comp revoke <email|domain> --actor <you>` — entitle a store without charging it.
 *
 * Entitlement is a local row and nothing else: a store with no subscription row
 * writes nothing and publishes nothing, whatever else is connected. A comped row
 * is how a store the founder does not charge — the pilot store, a partner, one
 * of our own — gets past the two gates that ask.
 *
 * It carries no payment, so it has no Stripe subscription id, no price and no
 * period end, and nothing expires it. Revoking is a person's decision, which is
 * why there is a command for it rather than a clock.
 *
 * `--actor` and `--reason` are not ceremony: this is entitlement granted outside
 * the way everyone else gets it, and six months from now the only record of why
 * a particular store was free is the one written here. They go into the journal
 * line this prints, which is meant to be pasted into `DECISIONS.md`.
 *
 * The store is named by the email it signed up with or by its claimed domain,
 * because those are the two things a founder has to hand. Domains are matched
 * against the normalised form, so `https://www.example.com/` finds the same
 * account as `example.com`.
 *
 * Runs under `tsx`; the repo consumes workspace packages as TypeScript source.
 */
import { closeDb, dbPool } from '../packages/db/src/client.ts'
import { normaliseClaimDomain } from '../packages/core/src/domain/normalise.ts'

const argv = process.argv.slice(2).filter((arg) => arg !== '--')
const [command, ...rest] = argv

function usage(code) {
  console.log(`Usage:
  pnpm comp list
  pnpm comp grant  <email|domain> --actor <you> --reason "<why>"
  pnpm comp revoke <email|domain> --actor <you>

A comped account is entitled without paying: it passes the generation gate and
the publishing gate exactly as a paying account does. Nothing expires it.

"revoke" deletes the comped row, which leaves the account unentitled — it keeps
every screen and everything already written, and stops writing anything new.
It refuses to touch a row that has a payment behind it.`)
  process.exit(code)
}

if (!command || command === '--help' || command === '-h') usage(2)
if (!process.env.DATABASE_URL) {
  console.error('FAIL  DATABASE_URL is not set')
  process.exit(1)
}

function option(name) {
  const at = rest.indexOf(`--${name}`)
  return at === -1 ? undefined : rest[at + 1]
}

/**
 * Finds the one account a name means, or explains why it cannot.
 *
 * Deliberately not "the first match": granting entitlement to the wrong store is
 * both a bill and a stranger's storefront being written to, so an ambiguous name
 * stops rather than picks.
 */
async function findAccount(pool, name) {
  const byEmail = await pool.query(
    `SELECT id, email FROM accounts WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
    [name],
  )
  if (byEmail.rows.length === 1) return byEmail.rows[0]

  let normalized
  try {
    normalized = normaliseClaimDomain(name).normalized
  } catch {
    return null
  }
  const byDomain = await pool.query(
    `SELECT a.id, a.email FROM accounts a
       JOIN domains d ON d.account_id = a.id
      WHERE d.domain_normalized = $1 AND a.deleted_at IS NULL`,
    [normalized],
  )
  if (byDomain.rows.length > 1) {
    throw new Error(`"${name}" matches ${byDomain.rows.length} accounts; name one by its email instead.`)
  }
  return byDomain.rows[0] ?? null
}

const pool = dbPool()

try {
  if (command === 'list') {
    const { rows } = await pool.query(
      `SELECT a.email, d.domain_normalized AS domain, s.synced_at
         FROM subscriptions s
         JOIN accounts a ON a.id = s.account_id
         LEFT JOIN domains d ON d.account_id = a.id
        WHERE s.status = 'comped'
        ORDER BY s.synced_at DESC`,
    )
    if (rows.length === 0) {
      console.log('No comped accounts.')
    } else {
      console.log(`${rows.length} comped account(s):\n`)
      for (const row of rows) {
        console.log(`  ${row.email}${row.domain ? `  (${row.domain})` : '  (no domain claimed)'}`)
        console.log(`    since ${new Date(row.synced_at).toISOString()}`)
      }
    }
  } else if (command === 'grant' || command === 'revoke') {
    const name = rest[0]
    const actor = option('actor')
    const reason = option('reason')
    if (!name || name.startsWith('--') || !actor) usage(2)
    if (command === 'grant' && !reason) {
      console.error('FAIL  --reason is required: it is the only record of why this store is free.')
      process.exit(1)
    }

    const account = await findAccount(pool, name)
    if (!account) {
      console.error(`FAIL  no account matches "${name}" by email or claimed domain.`)
      process.exit(1)
    }

    if (command === 'grant') {
      // Insert-or-update in one statement, and refuse to overwrite a paying
      // row: a merchant who is actually being charged must not be quietly
      // switched to free, because the charge would continue with nothing in our
      // own records saying they were paying for it.
      const { rows } = await pool.query(
        `INSERT INTO subscriptions (account_id, stripe_subscription_id, price_id, status,
                                    current_period_end, cancel_at_period_end)
         VALUES ($1::uuid, NULL, NULL, 'comped', NULL, false)
         ON CONFLICT (account_id) DO UPDATE
            SET status = 'comped', stripe_subscription_id = NULL, price_id = NULL,
                current_period_end = NULL, cancel_at_period_end = false,
                synced_at = now()
          WHERE subscriptions.stripe_subscription_id IS NULL
         RETURNING status`,
        [account.id],
      )
      if (rows.length === 0) {
        console.error(
          `FAIL  ${account.email} has a subscription with a payment behind it. Cancel that first; this script will not overwrite it.`,
        )
        process.exit(1)
      }
      console.log(`OK    ${account.email} is comped: entitled, not charged, until somebody revokes it.`)
      console.log(`\nJournal line for DECISIONS.md:`)
      console.log(
        `  ${new Date().toISOString().slice(0, 10)} — ${account.email} comped by ${actor} — ${reason}`,
      )
    } else {
      const { rows } = await pool.query(
        `DELETE FROM subscriptions
          WHERE account_id = $1::uuid AND status = 'comped' AND stripe_subscription_id IS NULL
         RETURNING account_id`,
        [account.id],
      )
      if (rows.length === 0) {
        console.error(`FAIL  ${account.email} has no comped row to revoke.`)
        process.exit(1)
      }
      console.log(`OK    ${account.email} is no longer entitled. Everything already written stays readable.`)
      console.log(`\nJournal line for DECISIONS.md:`)
      console.log(`  ${new Date().toISOString().slice(0, 10)} — ${account.email} comp revoked by ${actor}`)
    }
  } else {
    usage(2)
  }
} finally {
  await closeDb()
}
