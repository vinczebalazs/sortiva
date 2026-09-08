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
 * What this test bans is therefore not one word but a short list of names, each
 * of which hands a caller the merchant's own prose:
 *
 *   - the column itself, under either spelling;
 *   - the function that decompresses it, because calling it is reading it;
 *   - the paged read that returns a batch of descriptions as plain text, which
 *     is the same prose one transformation later.
 *
 * An earlier version of this test banned only the first of those. A sweep on
 * 2026-09-08 broke the rule by having the persona module call the decompressor
 * on a row variable — the column's name appeared nowhere — and every assertion
 * here stayed green. The mutations at the bottom of this file are that hole and
 * several of its neighbours, run through the same detection the repository scan
 * uses, so a later reader can see which shapes were tried.
 *
 * Comments are ignored on purpose. The rule is about *code paths*, and a
 * comment explaining the quarantine is the opposite of a violation of it.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

function paths(...list: readonly string[]): ReadonlySet<string> {
  return new Set(list.map((path) => path.split('/').join(sep)))
}

/** This file names every banned word, in the table below and in the mutations. */
const THIS_FILE = 'packages/core/src/distill/quarantine.test.ts'

interface Quarantined {
  /** The identifier or column name a file may not contain. */
  readonly name: string
  /** What a file gains by naming it — the reason it is on this list. */
  readonly hands: string
  /** The files that may name it. Adding one is the decision this test forces. */
  readonly allowed: ReadonlySet<string>
}

/**
 * Adding a file to one of these lists is the whole decision this test exists to
 * force someone to make in the open.
 */
const QUARANTINED: readonly Quarantined[] = [
  {
    name: 'rawBodyHtml',
    hands: 'the stored description, compressed',
    allowed: paths(
      // Declares the column.
      'packages/db/src/schema/catalog.ts',
      // The one place that reads and decompresses it.
      'packages/db/src/repositories/catalog.ts',
      // That boundary's own test — a boundary with no test is one nobody checked.
      'packages/db/src/catalog.test.ts',
      // Where a description arrives from Shopify and is written to the row.
      'packages/core/src/catalog/products.ts',
      THIS_FILE,
      // Asserts the description is still stored and still not in the fact sheet.
      'packages/jobs/src/ingestion/distill.test.ts',
      // Seeds a real description for the chaos scenario to distil, the same way
      // `distill.test.ts` above does.
      'packages/jobs/src/chaos/distill.scenario.ts',
      // Stores a description on a product and then asserts it is absent from the
      // bytes `GET /api/products` answers with. Proving the description never
      // reaches a merchant-facing response means putting one there first.
      'apps/web/app/api/products/_lib/products-read.test.ts',
      // Names the field and stores nothing in it. An article's detail needs a
      // product to rest on, and the product input requires this key even when it
      // is null — so this file mentions the name without carrying a word of a
      // merchant's marketing copy. It seeded a real description until the gate
      // caught it; the test never asserted on it.
      'apps/web/app/api/articles/_lib/article-detail.test.ts',
      // Same shape as the line above, and the same nothing stored in it: the
      // weekly scan's hold-completion test needs a catalogue to measure, and the
      // product input requires this key even when it is null.
      'packages/jobs/src/scan/expiry.test.ts',
    ),
  },
  {
    name: 'raw_body_html',
    hands: 'the same column, under its SQL name',
    allowed: paths(
      'packages/db/src/schema/catalog.ts',
      'packages/db/src/repositories/catalog.ts',
      'packages/db/src/catalog.test.ts',
      THIS_FILE,
      'packages/jobs/src/ingestion/distill.test.ts',
    ),
  },
  {
    name: 'readProductBody',
    hands: 'the description as text, straight out of the column',
    allowed: paths(
      // Defines it, and is the only place that calls it.
      'packages/db/src/repositories/catalog.ts',
      // Asserts the round trip through compression still returns what went in.
      'packages/db/src/catalog.test.ts',
      THIS_FILE,
    ),
  },
  {
    name: 'productsForDistillation',
    hands: 'a whole page of descriptions as text, with no column named anywhere',
    allowed: paths(
      // Defines it, and is where the decompressed text is stripped down to the
      // `descriptionText` the distiller is allowed to see.
      'packages/db/src/repositories/catalog.ts',
      // The distillation step — the one consumer the quarantine exists to
      // permit, and the reason the read exists at all.
      'packages/jobs/src/ingestion/distill.ts',
      THIS_FILE,
    ),
  },
]

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
 * Parsed rather than matched as text, for two reasons. A doc comment naming the
 * column — this file is full of them — is not a read of it, and comments are not
 * nodes, so parsing drops them for free. And the raw token scanner this used to
 * call pairs the backticks in a SQL template wrongly, handing back a single
 * blob of everything between two of them: half of `repositories/catalog.ts`
 * arrived as one "string", comments included. Names inside such a blob were
 * still found by substring, so the rule held — but the exact-name count below
 * could not have been written on top of it.
 */
function namesInSource(source: string, kind: ts.ScriptKind = ts.ScriptKind.TS): Set<string> {
  const parsed = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, false, kind)
  const names = new Set<string>()

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) names.add(node.text)
    else if (ts.isStringLiteralLike(node)) names.add(node.text)
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      names.add(node.text)
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(parsed, visit)
  return names
}

/** Parsed once per file: the scan below asks four questions of every source. */
const cache = new Map<string, Set<string>>()

function namesIn(file: string): Set<string> {
  const hit = cache.get(file)
  if (hit) return hit
  const names = namesInSource(
    readFileSync(file, 'utf8'),
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  cache.set(file, names)
  return names
}

function mentionsQuarantined(names: Set<string>): boolean {
  for (const entry of QUARANTINED) {
    for (const name of names) if (name.includes(entry.name)) return true
  }
  return false
}

/** The banned names a file reaches, given what it says and where it lives. */
function disallowed(names: Set<string>, path: string): string[] {
  const here = path.split('/').join(sep)
  return QUARANTINED.filter((entry) => {
    if (entry.allowed.has(here)) return false
    for (const name of names) if (name.includes(entry.name)) return true
    return false
  }).map((entry) => entry.name)
}

/**
 * The whole rule, applied to a file's text rather than to a file.
 *
 * The mutations at the bottom go through this so they exercise the function the
 * repository scan uses, instead of a second copy of it that could drift into
 * agreeing with itself.
 */
function violationsIn(path: string, source: string): string[] {
  return disallowed(
    namesInSource(source, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
    path,
  )
}

function violationsInFile(file: string): string[] {
  return disallowed(namesIn(file), relative(repoRoot, file))
}

describe('the quarantine on raw product descriptions', () => {
  const files = [
    ...sourceFiles(join(repoRoot, 'packages')),
    ...sourceFiles(join(repoRoot, 'apps')),
  ]

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('is reached nowhere outside the catalogue module and the distiller', () => {
    const violations: string[] = []
    for (const file of files) {
      const found = violationsInFile(file)
      if (found.length > 0) {
        violations.push(`${relative(repoRoot, file)} — names ${found.join(', ')}`)
      }
    }
    expect(violations).toEqual([])
  })

  it('is not vacuous: every banned name is really used by a file allowed to use it', () => {
    // If a name were changed and this table left behind, the scan above would
    // pass against nothing. Each entry has to still match something real.
    for (const entry of QUARANTINED) {
      const users = files.filter((file) => {
        const path = relative(repoRoot, file)
        if (path === THIS_FILE.split('/').join(sep)) return false
        for (const name of namesIn(file)) if (name.includes(entry.name)) return true
        return false
      })
      expect(users, entry.name).not.toEqual([])
    }
  })

  it('leaves the column exactly one reader in shipping code', () => {
    // The header has claimed this since the file was written and nothing
    // asserted it. The count is what makes "one decompressor" a fact rather than
    // an intention, and it is what holds the gap the mutations below end on:
    // a scan over names cannot follow a value, so the value must have one source.
    // Tests are excluded — they check the reader, they are not a second one.
    const readers = files
      .map((file) => relative(repoRoot, file))
      .filter((path) => !/\.test\.tsx?$/.test(path))
      .filter((path) => namesIn(join(repoRoot, path)).has('readProductBody'))
    expect(readers).toEqual([join('packages', 'db', 'src', 'repositories', 'catalog.ts')])
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
      expect(mentionsQuarantined(namesIn(file)), file).toBe(false)
    }
    const ingestion = sourceFiles(join(repoRoot, 'packages/jobs/src/ingestion'))
      .filter((file) => violationsInFile(file).length > 0)
      .map((file) => relative(repoRoot, file))
    expect(ingestion).toEqual([])
  })

  it('leaves distillation itself on the far side of the boundary', () => {
    // The step that needs a description does not read the column: it is handed
    // plain text by the catalogue repository, which is the only decompressor.
    for (const file of sourceFiles(join(repoRoot, 'packages/core/src/distill'))) {
      const path = relative(repoRoot, file)
      if (path === THIS_FILE.split('/').join(sep)) continue
      expect(mentionsQuarantined(namesIn(file)), path).toBe(false)
    }
  })
})

/**
 * What this check has actually been tried against.
 *
 * Every case below is a way of getting a merchant's product prose into the
 * persona module — the step that must never see it. They go through
 * `violationsIn`, the same function the repository scan uses, so a green scan
 * and a green mutation cannot quietly disagree.
 *
 * Two are the sweep's, and one of those is why this file changed. The rest are
 * shapes nobody had tried, written down so the next reader can see the check was
 * pushed at rather than only demonstrated.
 */
const PERSONA_FILE = 'packages/core/src/persona/brief.ts'

describe('the mutations this check has been tried against', () => {
  it("catches the sweep's first mutation: naming the column", () => {
    const source = `
      import type { ProductRecord } from '@sortiva/db'
      export function voice(row: Pick<ProductRecord, 'rawBodyHtml'>) {
        return row.rawBodyHtml
      }
    `
    expect(violationsIn(PERSONA_FILE, source)).toContain('rawBodyHtml')
  })

  it("catches the sweep's second mutation, which used to pass: calling the decompressor", () => {
    // This is the hole. The column's name appears nowhere; the merchant's
    // marketing copy arrives all the same, and six assertions stayed green.
    const source = `
      import { readProductBody } from '@sortiva/db'
      export function voice(row: never) {
        return readProductBody(row)
      }
    `
    expect(violationsIn(PERSONA_FILE, source)).toContain('readProductBody')
  })

  it('catches one the sweep did not try: taking a whole page of descriptions', () => {
    // Neither the column nor the decompressor is named. `productsForDistillation`
    // hands back every product's description as stripped text — the same prose
    // one transformation later, and the larger prize of the two.
    const source = `
      import { productsForDistillation } from '@sortiva/db'
      export async function voice(db: never, scope: never) {
        const batch = await productsForDistillation(db, scope, { limit: 500 })
        return batch.map((product) => product.descriptionText)
      }
    `
    expect(violationsIn(PERSONA_FILE, source)).toContain('productsForDistillation')
  })

  it('catches one the sweep did not try: laundering the reader through a re-export', () => {
    // Renaming on the way out would defeat a check that only looked at call
    // sites. It does not defeat this one, because the file doing the renaming
    // has to say the original name once — and that file is caught.
    const source = `export { readProductBody as storeVoice } from '@sortiva/db'`
    expect(violationsIn('packages/core/src/persona/launder.ts', source)).toContain(
      'readProductBody',
    )
  })

  it('catches one the sweep did not try: the column named only inside a raw query', () => {
    const source = `
      export async function voice(db: never) {
        return db.execute('select raw_body_html from products')
      }
    `
    expect(violationsIn(PERSONA_FILE, source)).toContain('raw_body_html')
  })

  /**
   * The boundary, stated rather than implied.
   *
   * This is a scan over source text. It sees names, so it stops a module that
   * asks for the description by any of the names that yield it. It cannot follow
   * a value: if a file that is allowed to read the column hands the text onward
   * through an innocent-looking parameter, or a name is assembled at run time,
   * nothing here fires.
   *
   * What holds that gap shut is not this scan but the assertion above that the
   * column has exactly one reader in shipping code, and that the reader is
   * called from one place. Widening either allowlist reopens it, which is why
   * adding a file is meant to be an argument rather than a line.
   */
  it('does not catch an indirect read, and that is the limit of what it can promise', () => {
    const handedOnByAnAllowedFile = `
      import { storeFacts } from '@sortiva/db'
      export async function voice(db: never, scope: never) {
        const facts = await storeFacts(db, scope)
        return facts.map((fact) => fact.text)
      }
    `
    expect(violationsIn(PERSONA_FILE, handedOnByAnAllowedFile)).toEqual([])

    const assembledAtRunTime = `
      export function voice(row: Record<string, unknown>) {
        return row[['raw', 'body', 'html'].join('_')]
      }
    `
    expect(violationsIn(PERSONA_FILE, assembledAtRunTime)).toEqual([])
  })
})
