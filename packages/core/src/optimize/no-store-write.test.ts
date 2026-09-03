import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * OPTIMIZE recommends and never edits. Invariant 21, main §10.1: collections,
 * products and pages are things the merchant maintains by hand, and changing
 * them would need write access to exactly the entities they edit themselves.
 * The V1 answer is a recommendation they apply, and this is what keeps it that
 * way when somebody later notices how close the code is to being able to do it.
 *
 * Three separate ways in, all closed here: reaching a Shopify client from this
 * directory, naming a write scope, and reaching the two-phase external-write
 * protocol that exists for publishing our own articles.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..', '..', '..', '..')

const WATCHED = [
  join(repoRoot, 'packages', 'core', 'src', 'optimize'),
  join(repoRoot, 'packages', 'jobs', 'src', 'optimize'),
  join(repoRoot, 'apps', 'web', 'app', 'api', 'recommendations'),
]

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * Each pattern is a way a write to the merchant's store could be reached from
 * here. `write_` covers both OAuth scopes (`write_content`, `write_products`).
 */
const FORBIDDEN: readonly (readonly [label: string, pattern: RegExp])[] = [
  ['a Shopify client', /\bShopifyAdmin\w*|\bshopifyClient\b|@sortiva\/providers\/shopify/],
  ['a Shopify write scope', /\bwrite_(content|products|themes)\b/],
  ['the publish-intent protocol', /\bpublish_intents\b|\bpublishIntents\b|\bexecutePublishIntent\b/],
  ['a GraphQL mutation', /\bmutation\s+\w*\s*\{|productUpdate|collectionUpdate|pageUpdate/],
]

describe('OPTIMIZE never writes to the merchant\'s store', () => {
  const files = WATCHED.flatMap(sourceFiles)

  it('has the OPTIMIZE code to check', () => {
    expect(files.length, `nothing found under ${WATCHED.join(', ')}`).toBeGreaterThan(0)
  })

  for (const [label, pattern] of FORBIDDEN) {
    it(`contains no reference to ${label}`, () => {
      const offenders = files.filter((file) => {
        const source = readFileSync(file, 'utf8')
        // This file names all of them by definition.
        if (file.endsWith('no-store-write.test.ts')) return false
        return pattern.test(source)
      })
      expect(offenders.map((file) => relative(repoRoot, file))).toEqual([])
    })
  }
})
