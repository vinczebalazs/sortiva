import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * The quarantine on a merchant's own product descriptions, enforced rather than
 * promised.
 *
 * A product's `raw_body_html` is kept for display and debugging and is **never**
 * an input to persona construction, topic selection, evidence packs or
 * recommendations. The reason is not tidiness: a merchant's marketing copy fed
 * back into what we write for them is how a system ends up confidently
 * repeating claims nobody checked, and how every article inherits the register
 * of an advert and then fails our own quality gate for sounding like one. Only
 * the distilled fact sheet flows downstream.
 *
 * So the column has exactly one reader in the whole repository — the catalogue
 * repository, which decompresses it, turns it into plain text and hands that to
 * distillation. This test is what keeps that true as the product grows: any
 * other module that so much as names the column fails the build, and the
 * failure names the file.
 *
 * Comments are ignored on purpose. The rule is about *code paths*, and a
 * comment explaining the quarantine is the opposite of a violation of it.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/** The property name in our code, and the column name in SQL and in a raw query. */
const QUARANTINED = ['rawBodyHtml', 'raw_body_html']

/**
 * Where the description may be touched at all.
 *
 * `schema/catalog.ts` declares the column; `repositories/catalog.ts` is the one
 * place that reads it, and the only place that decompresses it. Their tests are
 * allowed because a boundary with no test of its own is a boundary nobody has
 * checked. `core/catalog/products.ts` is where a description arrives from
 * Shopify and is written to the row.
 *
 * Adding a file to this list is the whole decision this test exists to force
 * someone to make in the open.
 */
const ALLOWED = new Set(
  [
    'packages/db/src/schema/catalog.ts',
    'packages/db/src/repositories/catalog.ts',
    'packages/db/src/catalog.test.ts',
    'packages/core/src/catalog/products.ts',
    'packages/core/src/distill/quarantine.test.ts',
    // Asserts the description is still stored and still not in the fact sheet.
    'packages/jobs/src/ingestion/distill.test.ts',
  ].map((path) => path.split('/').join(sep)),
)

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'coverage', '.turbo'])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * Every identifier and string literal in one file, comments excluded.
 *
 * Scanned as tokens rather than matched as text so that a doc comment naming
 * the column — this file is full of them — is not mistaken for a read of it.
 */
function namesIn(file: string): Set<string> {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ true)
  scanner.setText(readFileSync(file, 'utf8'))

  const names = new Set<string>()
  let token = scanner.scan()
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.Identifier ||
      token === ts.SyntaxKind.StringLiteral ||
      token === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      token === ts.SyntaxKind.TemplateHead ||
      token === ts.SyntaxKind.TemplateMiddle ||
      token === ts.SyntaxKind.TemplateTail
    ) {
      names.add(scanner.getTokenValue())
    }
    token = scanner.scan()
  }
  return names
}

function mentionsQuarantined(names: Set<string>): boolean {
  for (const name of names) {
    if (QUARANTINED.some((needle) => name.includes(needle))) return true
  }
  return false
}

describe('the quarantine on raw product descriptions', () => {
  const files = [
    ...sourceFiles(join(repoRoot, 'packages')),
    ...sourceFiles(join(repoRoot, 'apps')),
  ]

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('is named nowhere outside the catalogue module', () => {
    const violations: string[] = []
    for (const file of files) {
      const path = relative(repoRoot, file)
      if (ALLOWED.has(path)) continue
      if (mentionsQuarantined(namesIn(file))) violations.push(path)
    }
    expect(violations).toEqual([])
  })

  it('is not vacuous: the files that may touch it really do', () => {
    // If the column were renamed and this test left behind, it would pass
    // against nothing. These two are its floor.
    expect(mentionsQuarantined(namesIn(join(repoRoot, 'packages/db/src/schema/catalog.ts')))).toBe(true)
    expect(
      mentionsQuarantined(namesIn(join(repoRoot, 'packages/db/src/repositories/catalog.ts'))),
    ).toBe(true)
  })

  it('ignores a comment, because a comment is not a read path', () => {
    // `packages/db/src/schema/content.ts` explains that a store page's body is
    // compressed "like raw_body_html" and never touches the column.
    const content = join(repoRoot, 'packages/db/src/schema/content.ts')
    expect(readFileSync(content, 'utf8')).toContain('raw_body_html')
    expect(mentionsQuarantined(namesIn(content))).toBe(false)
  })

  it('leaves the persona on the far side of the boundary', () => {
    // The persona is the step most tempted by a raw description — "read their
    // copy so we can match their voice" is a reasonable-sounding sentence and a
    // direct violation. It reasons about families, best sellers and the store's
    // own pages instead, and none of those is the column.
    for (const file of sourceFiles(join(repoRoot, 'packages/core/src/persona'))) {
      expect(mentionsQuarantined(namesIn(file))).toBe(false)
    }
    for (const file of sourceFiles(join(repoRoot, 'packages/jobs/src/ingestion'))) {
      if (relative(repoRoot, file) === join('packages', 'jobs', 'src', 'ingestion', 'distill.test.ts')) {
        continue
      }
      expect(mentionsQuarantined(namesIn(file))).toBe(false)
    }
  })

  it('leaves distillation itself on the far side of the boundary', () => {
    // The step that needs a description does not read the column: it is handed
    // plain text by the catalogue repository, which is the only decompressor.
    for (const file of sourceFiles(join(repoRoot, 'packages/core/src/distill'))) {
      if (relative(repoRoot, file) === join('packages', 'core', 'src', 'distill', 'quarantine.test.ts')) {
        continue
      }
      expect(mentionsQuarantined(namesIn(file))).toBe(false)
    }
  })
})
