import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CLIENT_EXPORTS } from './rules/no-raw-db-access.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The rule that stops code reaching a database table without naming an account
 * derives its *table* list from the schema, so that half cannot go stale. The
 * other half — the live handles `client.ts` exports — is written by hand, and it
 * did go stale: `dbPool`, the raw connection pool, was missing, and a file was
 * already importing it straight past the rule.
 *
 * A hand-written list beside a derived one is the part that rots. This fails the
 * moment `client.ts` exports a runtime handle the rule does not know about.
 */
describe('the raw-database lint rule knows every handle the client exports', () => {
  it('bans every value packages/db/src/client.ts exports', () => {
    const source = readFileSync(join(repoRoot, 'packages/db/src/client.ts'), 'utf8')

    const exported = new Set<string>()
    for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/g)) {
      exported.add(m[1]!)
    }
    for (const m of source.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const part of m[1]!.split(',')) {
        const trimmed = part.trim()
        if (trimmed.startsWith('type ')) continue
        const name = trimmed.split(/\s+as\s+/).pop()!.trim()
        if (name) exported.add(name)
      }
    }

    // Types are not runtime handles; the rule only guards values.
    const values = [...exported].filter((name) => !/^[A-Z]/.test(name))
    expect(values.length, 'found no exports — the scan itself is broken').toBeGreaterThan(0)

    const banned = new Set(CLIENT_EXPORTS)
    const missing = values.filter((name) => !banned.has(name))
    expect(
      missing,
      `client.ts exports these and the lint rule does not ban them: ${missing.join(', ')}`,
    ).toEqual([])
  })
})
