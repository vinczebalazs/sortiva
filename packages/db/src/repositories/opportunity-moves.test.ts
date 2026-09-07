import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { assertMoveIsDrawn } from './opportunity-moves'
import { canTransition, InvalidOpportunityTransitionError } from '@sortiva/core'

/**
 * "Every status write asks the lifecycle first" is only true if there is no
 * write somewhere that does not. Listing them by hand is how the last two
 * disagreements were missed, so this reads the repository sources instead and
 * fails on a write it has not been told about.
 *
 * A new status write therefore has one of two fates: it calls the check, or
 * somebody has to come here and say in words why it is not a move.
 */

const here = fileURLToPath(new URL('.', import.meta.url))

/**
 * The two writes that are not moves. A row coming into existence has no
 * previous status to move from, so there is no edge to check — the lifecycle
 * has nothing to say about it. Both are named rather than pattern-matched, so
 * a third insert has to be argued for here rather than inheriting the excuse.
 */
const NOT_A_MOVE = new Set([
  // A detected signal's first sighting.
  'upsertOpportunity',
  // The placeholder row a manually-added calendar topic hangs off.
  'insertMinimalOpportunity',
])

interface StatusWrite {
  readonly file: string
  readonly fn: string
  readonly asksTheLifecycle: boolean
}

function repositoryFiles(): string[] {
  return readdirSync(here)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(here, name))
}

/** Every function in the repositories that puts a new status on an opportunity row. */
function statusWrites(): StatusWrite[] {
  const found: StatusWrite[] = []

  for (const file of repositoryFiles()) {
    const text = readFileSync(file, 'utf8')
    if (!text.includes('.update(opportunities)')) continue

    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true)
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        const body = node.body.getFullText(source)
        // An update that names `status` in what it sets. `updatedAt` alone is
        // not a move — several writes touch only the outcome or the topic id.
        const writesStatus =
          body.includes('.update(opportunities)') && /\.set\(\{[^}]*\bstatus:/s.test(body)
        if (writesStatus) {
          found.push({
            file: relative(here, file),
            fn: node.name.text,
            asksTheLifecycle: body.includes('assertMoveIsDrawn('),
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  return found
}

describe('no opportunity status write escapes the lifecycle', () => {
  it('finds the status writes at all — so an empty scan cannot pass as a clean one', () => {
    const writes = statusWrites()
    expect(writes.length).toBeGreaterThanOrEqual(6)
  })

  it('every one of them asks the lifecycle before it writes', () => {
    const silent = statusWrites().filter(
      (write) => !write.asksTheLifecycle && !NOT_A_MOVE.has(write.fn),
    )
    expect(silent.map((write) => `${write.file}:${write.fn}`)).toEqual([])
  })

  it('names the writes it found, so a new one shows up as a change here', () => {
    expect(statusWrites().map((write) => `${write.file}:${write.fn}`).sort()).toEqual([
      'opportunities.ts:dismissOpportunityGuarded',
      'opportunities.ts:expireOpportunity',
      'opportunities.ts:transitionOpportunityStatus',
      'optimize.ts:markOpportunityApplied',
      'optimize.ts:releaseAbandonedOptimizeGenerations',
      'repair.ts:completeRepair',
    ])
  })
})

/**
 * The generic mover carries no guard of its own — each caller names the
 * statuses it is willing to move a row out of, so the disagreements that
 * matter live at the call sites. This walks every one of them in the whole
 * product and checks the pair against the lifecycle without running anything.
 *
 * A call whose destination is worked out at run time cannot be checked this
 * way. Those are listed by name below and are exercised for real instead.
 */
const repoRoot = join(here, '..', '..', '..', '..')
const SCANNED_ROOTS = [
  join(repoRoot, 'packages'),
  join(repoRoot, 'apps', 'web', 'app'),
]

/** Call sites whose `from` or `to` is a variable — proved by being run, not read. */
const WORKED_OUT_AT_RUN_TIME = [
  // The weekly scan re-blocks or un-blocks a row it re-detected; both ends come
  // off the row and the reconciliation.
  'packages/jobs/src/scan/run.ts',
  // Queueing the work failed, so the press is put back exactly where it came
  // from — `new` or `accepted`, whichever the row was.
  'apps/web/app/api/recommendations/_lib/handlers.ts',
  // Dismissal is willing to start from any status the row is still open in.
  'packages/db/src/repositories/opportunities.ts',
]

interface CallSite {
  readonly file: string
  readonly from: readonly string[] | null
  readonly to: string | null
}

function sourceFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFilesUnder(full))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

function literalStrings(node: ts.Node | undefined): readonly string[] | null {
  if (!node || !ts.isArrayLiteralExpression(node)) return null
  const values: string[] = []
  for (const element of node.elements) {
    if (ts.isStringLiteral(element)) values.push(element.text)
    else return null
  }
  return values
}

function moverCallSites(): CallSite[] {
  const sites: CallSite[] = []
  for (const root of SCANNED_ROOTS) {
    for (const file of sourceFilesUnder(root)) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes('transitionOpportunityStatus(')) continue
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true)
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'transitionOpportunityStatus'
        ) {
          const argument = node.arguments[3]
          let from: readonly string[] | null = null
          let to: string | null = null
          if (argument && ts.isObjectLiteralExpression(argument)) {
            for (const property of argument.properties) {
              if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue
              if (property.name.text === 'from') from = literalStrings(property.initializer)
              if (property.name.text === 'to' && ts.isStringLiteral(property.initializer)) {
                to = property.initializer.text
              }
            }
          }
          sites.push({ file: relative(repoRoot, file), from, to })
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  return sites
}

describe('every place that asks for a move names one the lifecycle draws', () => {
  it('finds the call sites at all', () => {
    expect(moverCallSites().length).toBeGreaterThanOrEqual(9)
  })

  it('draws every move whose two ends are written down in the code', () => {
    const undrawn: string[] = []
    for (const site of moverCallSites()) {
      if (site.from === null || site.to === null) continue
      for (const source of site.from) {
        if (!canTransition(source as never, site.to as never)) {
          undrawn.push(`${site.file}: ${source} -> ${site.to}`)
        }
      }
    }
    expect(undrawn).toEqual([])
  })

  it('has exactly the run-time-decided call sites it expects, and no others', () => {
    const dynamic = [
      ...new Set(
        moverCallSites()
          .filter((site) => site.from === null || site.to === null)
          .map((site) => site.file),
      ),
    ].sort()
    expect(dynamic).toEqual([...WORKED_OUT_AT_RUN_TIME].sort())
  })
})

describe('assertMoveIsDrawn', () => {
  it('refuses when any one of the statuses the guard admits could not legally move', () => {
    // `completed` is not a status anything moves out of, so a guard willing to
    // start from it is a guard that would perform a move nobody drew.
    expect(() => assertMoveIsDrawn(['accepted', 'completed'], 'dismissed')).toThrow(
      InvalidOpportunityTransitionError,
    )
  })

  it('allows a guard whose every starting status has the edge', () => {
    expect(() =>
      assertMoveIsDrawn(['new', 'accepted', 'scheduled', 'executing', 'blocked'], 'completed'),
    ).not.toThrow()
  })
})
