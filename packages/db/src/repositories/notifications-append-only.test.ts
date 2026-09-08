import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * What a notification says never changes, and nothing removes one except the
 * two things allowed to.
 *
 * A notification is a row saying "your article was published" or "reconnect
 * Search Console". The merchant sees it in the bell. It must not be possible to
 * rewrite one after the fact — a notification that can be edited is not a
 * record of what happened, it is a claim about what happened — and it must not
 * be possible to quietly remove one, because "I never got told" is exactly the
 * complaint the record exists to answer.
 *
 * Until now that was a sentence in a comment. The unique key that stops the
 * same bell ringing twice is real; nothing stopped an update or a delete.
 *
 * **This is a source check, and here is precisely what it can and cannot do.**
 * It reads every shipping file and fails, by name, on any update or delete
 * against the notifications table that is not on the short list below, and on
 * any allowed update that touches a column other than the two read-state
 * timestamps. What it cannot do is stop somebody with a database connection —
 * a migration, an admin script, a psql session — from doing either. Making
 * *that* impossible needs a database privilege or a trigger, which is a
 * migration, which is not a test's to write. Recorded in `DECISIONS.md` as the
 * integrator's call.
 *
 * It also does not read test files. A test that edits a row directly is a test,
 * not a product behaviour.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..', '..', '..', '..')

/** The drizzle table object, and the SQL name, so both spellings are covered. */
const TABLE_IDENTIFIER = 'notifications'
const RAW_SQL_WRITE = /\b(update\s+"?notifications"?|delete\s+from\s+"?notifications"?)/i

/**
 * The only writes to an existing notification the product is allowed to make.
 *
 * Both are real and both are needed, which is why "append-only" cannot be taken
 * literally here and this list exists instead of an empty one:
 *
 *  - the two that record that the merchant has *seen* or *read* the bell. They
 *    change nothing the notification says, only what the reader has done with
 *    it, and the check below proves that by looking at which columns they set.
 *  - the nightly retention sweep, which removes notifications older than the
 *    retention window. Keeping them for ever is the thing the retention policy
 *    forbids.
 *
 * Deleting an account also removes its notifications, through the foreign key's
 * cascade rather than through any code, so it does not appear here.
 */
const PERMITTED_WRITES: readonly { readonly file: string; readonly fn: string; readonly why: string }[] = [
  {
    file: join('packages', 'db', 'src', 'repositories', 'notifications.ts'),
    fn: 'markNotificationsSeen',
    why: 'opening the bell clears the badge; it changes no word of the notification',
  },
  {
    file: join('packages', 'db', 'src', 'repositories', 'notifications.ts'),
    fn: 'markNotificationRead',
    why: 'clicking one marks it read; it changes no word of the notification',
  },
  {
    file: join('packages', 'db', 'src', 'repositories', 'lifecycle.ts'),
    fn: 'pruneNotifications',
    why: 'the retention sweep, which is required to remove them past the window',
  },
]

/** The only columns an allowed update may set. Neither is part of what the notification says. */
const READ_STATE_COLUMNS = ['seenAt', 'readAt']

interface Write {
  readonly file: string
  readonly fn: string
  readonly operation: 'update' | 'delete'
  readonly setsColumns: readonly string[]
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry) && !/\.(test|test-d|spec)\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

/** The name of the function a node sits inside, for a message that points somewhere. */
function enclosingFunction(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      current.parent &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text
    }
  }
  return '<top level>'
}

/** The keys of the object literal handed to a `.set({ … })` chained onto this call. */
function columnsSetBy(call: ts.CallExpression): string[] {
  const access = call.parent
  if (!access || !ts.isPropertyAccessExpression(access) || access.name.text !== 'set') return []
  const setCall = access.parent
  if (!setCall || !ts.isCallExpression(setCall)) return []
  const [argument] = setCall.arguments
  if (!argument || !ts.isObjectLiteralExpression(argument)) return []
  return argument.properties.flatMap((property) =>
    property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ? [property.name.text]
      : [],
  )
}

function writesToNotifications(): Write[] {
  const found: Write[] = []

  for (const root of ['packages', 'apps']) {
    for (const file of sourceFiles(join(repoRoot, root))) {
      const text = readFileSync(file, 'utf8')
      const shortName = relative(repoRoot, file)

      // Raw SQL, which no parse of a template string would see as a call.
      if (RAW_SQL_WRITE.test(text)) {
        found.push({ file: shortName, fn: '<raw SQL>', operation: 'update', setsColumns: [] })
      }

      if (!text.includes(TABLE_IDENTIFIER)) continue
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)

      const walk = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          (node.expression.name.text === 'update' || node.expression.name.text === 'delete') &&
          node.arguments.length === 1 &&
          ts.isIdentifier(node.arguments[0]!) &&
          node.arguments[0]!.text === TABLE_IDENTIFIER
        ) {
          found.push({
            file: shortName,
            fn: enclosingFunction(node),
            operation: node.expression.name.text as 'update' | 'delete',
            setsColumns: columnsSetBy(node),
          })
        }
        ts.forEachChild(node, walk)
      }
      walk(source)
    }
  }

  return found
}

describe('a notification cannot be rewritten or removed', () => {
  const writes = writesToNotifications()

  it('finds the writes that do exist, so the check is not passing on an empty list', () => {
    // If this scan ever finds nothing — a rename, a broken walk — the two
    // assertions below would pass over an empty array and say nothing at all.
    expect(writes.length, 'the scan found no writes to notifications anywhere').toBeGreaterThan(0)
  })

  it('is written by nothing except the bell’s read state and the retention sweep', () => {
    const permitted = new Set(PERMITTED_WRITES.map((entry) => `${entry.file}:${entry.fn}`))
    const unexpected = writes
      .filter((write) => !permitted.has(`${write.file}:${write.fn}`))
      .map((write) => `${write.file}: ${write.fn} ${write.operation}s notifications`)

    expect(
      unexpected,
      'what a notification says is the record of what we told the merchant. Only the bell’s ' +
        'seen/read timestamps and the retention sweep may touch these rows; anything else needs ' +
        'a line in PERMITTED_WRITES saying why',
    ).toEqual([])
  })

  it('lets the bell record that it was opened, and nothing more', () => {
    const offending = writes
      .filter((write) => write.operation === 'update')
      .flatMap((write) =>
        write.setsColumns
          .filter((column) => !READ_STATE_COLUMNS.includes(column))
          .map((column) => `${write.file}: ${write.fn} sets ${column}`),
      )

    expect(
      offending,
      'seen and read are facts about the reader. Every other column is what the notification ' +
        'says, and it says it once',
    ).toEqual([])
  })

  it('names a reason for every write it permits', () => {
    for (const entry of PERMITTED_WRITES) {
      expect(entry.why.length, `${entry.fn} has no reason written down`).toBeGreaterThan(20)
    }
  })
})
