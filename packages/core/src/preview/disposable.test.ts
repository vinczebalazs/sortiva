import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Constitution invariant 2, main §3.1: "Preview output is disposable: nothing
 * from `preview_cache` is ever read by ingestion, persona, topics, or evidence.
 * Test asserts no import path from `preview` into `core`."
 *
 * Why this matters in plain terms: the preview is a public, logged-out teaser
 * built for a few cents — one homepage fetch and a Haiku summary. The real
 * analysis a paying merchant gets reads their whole catalog through an
 * authenticated Shopify connection. If a later card ever reached for the cheap
 * cached summary because it was already there, the merchant's persona,
 * opportunities and articles would quietly be built on the teaser. The type
 * system will not catch that; this will.
 *
 * The rule is enforced in both directions:
 *
 *  - **Nothing reads the preview.** No module anywhere may import the preview
 *    module or the `preview_cache` repository, except the preview itself, the
 *    barrel that re-exports it, and its own API route.
 *  - **The preview reads nothing.** The preview module may import only its own
 *    files and the shared contracts, so it cannot start depending on catalog,
 *    persona or opportunity code and become load-bearing.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..', '..', '..', '..')

/** Directories that are allowed to reach the preview module, and why. */
const PERMITTED_READERS = [
  join('packages', 'core', 'src', 'preview'), // itself
  join('packages', 'core', 'src', 'index.ts'), // the barrel `@sortiva/core` is imported from
  join('apps', 'web', 'app', 'api', 'preview'), // the endpoint that serves it
]

/** What the preview module itself may depend on. */
const PREVIEW_MAY_IMPORT = [/^\.\.?\//, /^node:/, /^vitest$/, /^typescript$/, /^@sortiva\/providers$/]

const PREVIEW_SPECIFIERS = [
  /(^|\/)preview(\/|$)/, // relative or package-path import of the module
  /@sortiva\/core\/preview/,
  /\breadPreviewCache\b/,
  /\bpreviewCache\b/,
  /\bpreview_cache\b/,
]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full)
  }
  return out
}

function importsOf(file: string): string[] {
  const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
  return info.importedFiles.map((f) => f.fileName)
}

const allFiles = [join(repoRoot, 'packages'), join(repoRoot, 'apps')].flatMap(sourceFiles)

describe('invariant 2 — preview output is disposable', () => {
  it('has the whole workspace in view (the scan is not vacuously empty)', () => {
    expect(allFiles.length).toBeGreaterThan(50)
    expect(allFiles.some((f) => f.includes(join('packages', 'db', 'src')))).toBe(true)
  })

  it('no module outside the preview imports the preview module', () => {
    const violations: string[] = []
    for (const file of allFiles) {
      const rel = relative(repoRoot, file)
      if (PERMITTED_READERS.some((allowed) => rel === allowed || rel.startsWith(allowed + sep))) {
        continue
      }
      for (const specifier of importsOf(file)) {
        if (PREVIEW_SPECIFIERS.some((pattern) => pattern.test(specifier))) {
          violations.push(`${rel} -> ${specifier}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('no module outside the preview names the preview cache repository or table', () => {
    const violations: string[] = []
    // `packages/db` legitimately declares the table and its reader; every other
    // mention outside the preview would be a read path into disposable data.
    const declarers = [join('packages', 'db', 'src'), join('packages', 'db', 'migrations')]
    for (const file of allFiles) {
      const rel = relative(repoRoot, file)
      if (PERMITTED_READERS.some((a) => rel === a || rel.startsWith(a + sep))) continue
      if (declarers.some((d) => rel.startsWith(d + sep))) continue
      const text = readFileSync(file, 'utf8')
      if (/\bpreviewCache\b|\breadPreviewCache\b|\bpreview_cache\b/.test(text)) {
        violations.push(rel)
      }
    }
    expect(violations).toEqual([])
  })

  it('the preview module depends only on its own files and the shared contracts', () => {
    const previewDir = join(repoRoot, 'packages', 'core', 'src', 'preview')
    const violations: string[] = []
    for (const file of sourceFiles(previewDir)) {
      for (const specifier of importsOf(file)) {
        if (!PREVIEW_MAY_IMPORT.some((pattern) => pattern.test(specifier))) {
          violations.push(`${relative(repoRoot, file)} -> ${specifier}`)
        }
        // A relative import may not climb out of preview/ except into contracts,
        // and into the claim's domain normaliser — one pure function, allowed by
        // name rather than by directory.
        //
        // The reason it is allowed at all is the reason the rest of this rule
        // exists. Preview spend has to be attributed to the domain a merchant
        // would later claim, or it never joins to their account (main §14.7).
        // That means the preview and the claim must agree on what the
        // registrable domain is — and two copies of that rule would drift, which
        // is a worse outcome than this one import. Nothing flows the other way:
        // no preview output, no cache, no summary. The three checks above still
        // prove that, and they are invariant 2 itself.
        const PERMITTED_CLIMB = ['../contracts', '../domain/normalise']
        if (specifier.startsWith('../') && !PERMITTED_CLIMB.some((a) => specifier.startsWith(a))) {
          violations.push(`${relative(repoRoot, file)} -> ${specifier}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('the rule is not vacuous: a planted import would be caught', () => {
    expect(PREVIEW_SPECIFIERS.some((p) => p.test('../preview/preview'))).toBe(true)
    expect(PREVIEW_SPECIFIERS.some((p) => p.test('@sortiva/core/preview'))).toBe(true)
    expect(PREVIEW_SPECIFIERS.some((p) => p.test('../contracts/llm'))).toBe(false)
  })
})
