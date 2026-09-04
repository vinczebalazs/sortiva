import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * FIX recommends and never executes.
 *
 * A merchant's redirects and canonical tags decide which of their addresses
 * exists as far as Google is concerned. Getting one wrong removes a page from
 * search, and unlike a bad paragraph nobody notices for weeks. So this product
 * writes neither, ever — it says which page should win and why, and the
 * merchant applies it in Shopify.
 *
 * Two checks, and they are different claims.
 *
 * The first is about the whole product: nothing anywhere so much as names
 * Shopify's redirect or theme-file surface, which is the only way a redirect
 * could be created. That is a stronger statement than "the FIX code does not do
 * it", and it is the one that stays true when somebody adds a feature nowhere
 * near this directory.
 *
 * The second is about this directory and the API around it: canonical
 * suggestions are written here, so here is where a write path would grow, and
 * every route to one is closed.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..', '..', '..', '..')

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next' || entry === '.turbo') {
      continue
    }
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** Every package's source, plus the web app — the whole of what ships. */
function productFiles(): string[] {
  const packagesDir = join(repoRoot, 'packages')
  const packages = existsSync(packagesDir)
    ? readdirSync(packagesDir).flatMap((name) => sourceFiles(join(packagesDir, name, 'src')))
    : []
  return [...packages, ...sourceFiles(join(repoRoot, 'apps', 'web', 'app'))]
}

/**
 * The Shopify resources through which a redirect, a theme edit or a stored
 * canonical could be created. Naming one is not proof of a write, but it is the
 * necessary first step of every one of them, so the absence of all of them is
 * proof that no such write exists.
 */
const REDIRECT_SURFACES: readonly (readonly [label: string, pattern: RegExp])[] = [
  ['a Shopify URL-redirect resource', /\burlRedirect|\bUrlRedirect|url_redirects?\b|redirects\.json/i],
  ['a Shopify theme or asset resource', /\bthemeFiles|\bScriptTag\b|scriptTags?\.json|assets\.json|\bwrite_themes\b/],
  ['a canonical tag being written', /canonicalUrl\s*[:=]|setCanonical|writeCanonical|rel=["']canonical["']/i],
]

const FIX_DIRECTORIES = [
  join(repoRoot, 'packages', 'core', 'src', 'fix'),
  join(repoRoot, 'apps', 'web', 'app', 'api', 'recommendations'),
]

/** The same three doors the OPTIMIZE guard closes, applied to the FIX code. */
const FORBIDDEN_IN_FIX: readonly (readonly [label: string, pattern: RegExp])[] = [
  ['a Shopify client', /\bShopifyAdmin\w*|\bshopifyClient\b|@sortiva\/providers\/shopify/],
  ['a Shopify write scope', /\bwrite_(content|products|themes)\b/],
  ['the publish-intent protocol', /\bpublish_intents\b|\bpublishIntents\b|\bexecutePublishIntent\b/],
  ['a GraphQL mutation', /\bmutation\s+\w*\s*\{|productUpdate|collectionUpdate|pageUpdate/],
]

function offenders(files: readonly string[], pattern: RegExp): string[] {
  return files
    .filter((file) => {
      // This file names every pattern by definition.
      if (file.endsWith('no-store-write.test.ts')) return false
      return pattern.test(readFileSync(file, 'utf8'))
    })
    .map((file) => relative(repoRoot, file))
}

describe('nothing in this product can write a redirect or a canonical', () => {
  const everything = productFiles()

  it('has the product to check', () => {
    expect(everything.length).toBeGreaterThan(100)
  })

  for (const [label, pattern] of REDIRECT_SURFACES) {
    it(`nowhere names ${label}`, () => {
      expect(offenders(everything, pattern)).toEqual([])
    })
  }
})

describe('the FIX code cannot reach the merchant\'s store at all', () => {
  const files = FIX_DIRECTORIES.flatMap(sourceFiles)

  it('has the FIX code to check', () => {
    expect(files.length, `nothing found under ${FIX_DIRECTORIES.join(', ')}`).toBeGreaterThan(0)
  })

  for (const [label, pattern] of FORBIDDEN_IN_FIX) {
    it(`contains no reference to ${label}`, () => {
      expect(offenders(files, pattern)).toEqual([])
    })
  }
})
