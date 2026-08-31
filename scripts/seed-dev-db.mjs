#!/usr/bin/env node
/**
 * `pnpm db:seed` — puts a deterministic development account in the database so
 * the Playwright suite has something to look at (build plan T0.6).
 *
 * The repo consumes workspace packages as TypeScript source (DECISIONS
 * 2026-08-27 T0.1), so this runs under `tsx`, which is also what `db:seed`'s
 * package.json entry invokes.
 *
 * It refuses to touch a database whose URL looks like production.
 */
import { seedDevDatabase } from '../packages/db/src/seed.ts'

const url = process.env.DATABASE_URL ?? ''
if (/railway|\bprod\b|amazonaws/i.test(url)) {
  console.error('FAIL  DATABASE_URL looks like a production database. Refusing to seed.')
  process.exit(1)
}

const result = await seedDevDatabase()
console.log(`Seeded account ${result.accountId} with domain ${result.domain}`)
console.log(
  `Catalog fixture: ${result.expected.products} products in ${result.expected.families} families`,
)
