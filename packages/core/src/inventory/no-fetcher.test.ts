import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * The inventory is assembled from what the store told us about itself, never by
 * going out and reading its pages. That is the whole premise: "Shopify Admin API
 * — no crawler in V1". A crawler appearing here would be a second way of
 * learning what a store contains, with different coverage, different failure modes
 * and a cost per page — and nothing about the product would look broken.
 *
 * So this fails if any file of the inventory — in the domain package or in the
 * background job that drives it — imports the guarded page fetcher, or reaches
 * for the network itself.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..', '..', '..', '..')

const INVENTORY_DIRS = [
  join(repoRoot, 'packages', 'core', 'src', 'inventory'),
  join(repoRoot, 'packages', 'jobs', 'src', 'inventory'),
]

/** The one guarded fetcher, its port, its stand-in, and the raw ways round them. */
const BANNED_IMPORTS = ['undici', 'node-fetch', 'axios', 'got', 'cheerio', 'jsdom', 'node:http', 'node:https']
const BANNED_IDENTIFIERS = [
  'GuardedPageFetcher',
  'MockPageFetcher',
  'StorePageFetcher',
  'DEFAULT_FETCH_BUDGET',
]

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

describe('the content inventory reads no pages', () => {
  const files = INVENTORY_DIRS.flatMap(sourceFiles)

  it('has the inventory files to check, in both packages', () => {
    for (const dir of INVENTORY_DIRS) {
      expect(sourceFiles(dir).length, `no source files under ${dir}`).toBeGreaterThan(0)
    }
  })

  it('imports no page fetcher and no HTTP library', () => {
    const violations: string[] = []
    for (const file of files) {
      const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
      for (const imported of info.importedFiles) {
        if (BANNED_IMPORTS.includes(imported.fileName)) {
          violations.push(`${relative(repoRoot, file)} -> ${imported.fileName}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('names no fetcher, and calls no bare fetch', () => {
    const violations: string[] = []
    for (const file of files) {
      if (file.endsWith('no-fetcher.test.ts')) continue
      const text = readFileSync(file, 'utf8')
      for (const identifier of BANNED_IDENTIFIERS) {
        if (new RegExp(`\\b${identifier}\\b`).test(text)) {
          violations.push(`${relative(repoRoot, file)} names ${identifier}`)
        }
      }
      // A bare `fetch(` is the crawler arriving without announcing itself. The
      // Shopify reads this module does make go through the one Admin client the
      // product has, which is handed in rather than built here.
      if (/(^|[^.\w])fetch\s*\(/.test(text)) {
        violations.push(`${relative(repoRoot, file)} calls fetch() directly`)
      }
    }
    expect(violations).toEqual([])
  })
})
