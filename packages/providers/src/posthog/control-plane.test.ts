import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Analytics is told, never asked.
 *
 * In plain terms: when we decide to stop spending money, or to halt a job,
 * that decision is read out of our own database. It is never read back from
 * the analytics vendor. The reason is the obvious one — a brake has to work on
 * the day the vendor is down, and the day the vendor is down is exactly when
 * something has gone wrong enough for a brake to matter. Analytics may watch a
 * brake being applied; it may never be what applies it.
 *
 * Until now that rule rested on the analytics port happening to have no method
 * that returns anything. That is a shape, not a check: adding
 * `isSpendingCapped(): Promise<boolean>` to the interface would have been an
 * ordinary-looking edit that nothing objected to, and a comment above the
 * spend-ledger tests claimed those tests covered this. They do not — they cover
 * what a spend row may contain.
 *
 * These are checks. Two of them, closing the two ways in:
 *
 *  1. **The port cannot grow a read.** Every method on `PosthogCapture` must
 *     return nothing. A method that answers a question has to return an
 *     answer, so this refuses one before it can be called.
 *  2. **The wrapper cannot ask the vendor.** The vendor's library can evaluate
 *     feature flags and fetch remote config — a perfectly good control plane,
 *     for somebody else's product. The one file allowed to import that library
 *     may not touch any of it.
 *
 * What these cannot see, stated rather than implied: they cover the analytics
 * port and the file that holds the vendor's library. Somebody who fetched the
 * vendor's HTTP API directly, from a file that imports nothing, would pass
 * both — that path is closed by the lint rule that keeps the vendor's library
 * to this directory, and by nothing else.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..', '..', '..', '..')

const PORT_FILE = join(repoRoot, 'packages', 'core', 'src', 'contracts', 'analytics.ts')
const WRAPPER_FILE = join(repoRoot, 'packages', 'providers', 'src', 'posthog', 'index.ts')

/** The analytics port. Named here so a rename does not quietly empty the check. */
const PORT_NAME = 'PosthogCapture'

/**
 * Everything on the vendor's own client that answers a question rather than
 * recording one. Any of these in the wrapper would make the vendor capable of
 * deciding what our code does next.
 */
const VENDOR_READ_CALLS = [
  'getFeatureFlag',
  'getFeatureFlagPayload',
  'getAllFlags',
  'getAllFlagsAndPayloads',
  'isFeatureEnabled',
  'reloadFeatureFlags',
  'getRemoteConfigPayload',
]

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}

function findInterface(source: ts.SourceFile, name: string): ts.InterfaceDeclaration {
  const found = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  )
  if (!found) throw new Error(`${name} is not declared in ${source.fileName}`)
  return found
}

/** A return type that carries no answer back to the caller. */
function returnsNothing(type: ts.TypeNode | undefined): boolean {
  if (!type) return false
  if (type.kind === ts.SyntaxKind.VoidKeyword) return true
  return /^Promise<\s*void\s*>$/.test(type.getText().replace(/\s+/g, ' ').trim())
}

describe('the analytics port cannot be asked a question', () => {
  it('declares only methods that return nothing', () => {
    const port = findInterface(parse(PORT_FILE), PORT_NAME)
    const reads: string[] = []

    for (const member of port.members) {
      const name = member.name && ts.isIdentifier(member.name) ? member.name.text : '<unnamed>'
      if (ts.isMethodSignature(member)) {
        if (!returnsNothing(member.type)) {
          reads.push(`${name}(): ${member.type?.getText() ?? 'inferred'}`)
        }
        continue
      }
      // A property is a read too: `flags: Record<string, boolean>` would be one.
      reads.push(`${name} is a property, not a method that records something`)
    }

    expect(
      reads,
      `${PORT_NAME} may only record. These members hand something back, which is what makes ` +
        `the analytics vendor able to decide what our code does`,
    ).toEqual([])
  })

  it('declares the methods the product actually captures through, so the check is not vacuous', () => {
    // A check over an empty list passes. If the port is ever emptied or
    // renamed, this fails rather than the one above going quiet.
    const port = findInterface(parse(PORT_FILE), PORT_NAME)
    const names = port.members.flatMap((member) =>
      member.name && ts.isIdentifier(member.name) ? [member.name.text] : [],
    )

    expect(names).toEqual([
      'capture',
      'captureAiGeneration',
      'captureSeoRequest',
      'captureException',
      'flush',
      'shutdown',
    ])
  })
})

describe('the wrapper never asks the analytics vendor anything', () => {
  it('calls none of the vendor’s flag or remote-config methods', () => {
    const source = parse(WRAPPER_FILE)
    const found: string[] = []

    const walk = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && VENDOR_READ_CALLS.includes(node.name.text)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        found.push(`${node.name.text} at line ${line}`)
      }
      ts.forEachChild(node, walk)
    }
    walk(source)

    expect(
      found,
      'the analytics vendor is telemetry and alerting. A flag read here would let it decide ' +
        'whether our own work runs, and it would stop deciding correctly the moment the vendor did',
    ).toEqual([])
  })

  it('is looking at the file that holds the vendor’s library, so the check is not vacuous', () => {
    expect(readFileSync(WRAPPER_FILE, 'utf8')).toContain("from 'posthog-node'")
  })
})
