/**
 * CLAUDE.md code-structure rules — "Every repository method requires an
 * `accountId` scope parameter; there is no unscoped table access outside
 * migrations and admin scripts"; tech §3 — "every query is
 * `WHERE account_id = session.account_id`, enforced by a repository layer".
 *
 * T0.3 made that unbreakable *inside* the three repository files it wrote: a
 * branded `AccountScope` value only `accountScope()` can produce, proved by a
 * compile-time test. It is bypassable everywhere else, because `@sortiva/db`
 * also re-exports every raw table object and the raw database handle — so
 * `db.select().from(notifications)`, with no account named anywhere, compiles
 * fine outside `packages/db`. Audit T0.3 [major]; remediation D5.
 *
 * This rule is the stopgap half of D5: the raw surface may only be imported
 * inside `packages/db`. It bans the imports, not the queries, which is the line
 * a lint rule can hold honestly — you cannot reach a table without naming it.
 *
 * The durable half (stop `@sortiva/db` publishing raw tables at all, and supply
 * the join-scoped helpers the job tables need) is a later card and touches
 * `packages/db`.
 *
 * Type-only imports are allowed: a type cannot execute a query. `Db`,
 * `Database`, `AccountScope` and the row types are the normal way to spell a
 * repository's signature.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCHEMA_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'db',
  'src',
  'schema',
)

/**
 * The live handles `@sortiva/db` exports. Four names, fixed by `client.ts`, and
 * not derivable from the schema.
 */
const CLIENT_EXPORTS = ['db', 'schema', 'createPool', 'closeDb']

/**
 * Every table `@sortiva/db` publishes, read out of the schema rather than
 * copied into a list here.
 *
 * R1 wrote the list by hand, before schema wave 2, and it named none of the 22
 * tables that wave added nor the 2 from wave 2b — so for those tables the rule
 * read as protection and was none (`docs/audits/remediation.md` D10 item 3). A
 * hand-maintained list of a growing set goes stale on the next migration; this
 * one cannot, because the schema is the list.
 *
 * The two failure modes of deriving it are both loud rather than silent: an
 * unreadable schema directory throws, and a table declared in a shape the
 * pattern does not recognise makes the counts disagree and throws. A rule that
 * quietly matches nothing is the exact failure this replaces.
 */
function tablesFromSchema() {
  const names = []
  let declarations = 0

  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
  for (const file of files) {
    const source = readFileSync(join(SCHEMA_DIR, file), 'utf8')
    declarations += (source.match(/pgTable\(/g) ?? []).length
    for (const match of source.matchAll(/export const ([A-Za-z0-9_$]+) = pgTable\(/g)) {
      names.push(match[1])
    }
  }

  if (names.length === 0) {
    throw new Error(
      `sortiva/no-raw-db-access found no tables in ${SCHEMA_DIR}. The rule bans what it can name, so an empty list disables it silently — failing the lint run instead.`,
    )
  }
  if (names.length !== declarations) {
    throw new Error(
      `sortiva/no-raw-db-access matched ${names.length} of ${declarations} pgTable() declarations in ${SCHEMA_DIR}. A table declared in an unrecognised shape would be exempt without anyone deciding that; declare it as \`export const <name> = pgTable(\` or teach this rule the new shape.`,
    )
  }
  return names
}

/** Everything `@sortiva/db` exports that is a table object or a live handle. */
const RAW_EXPORTS = [...CLIENT_EXPORTS, ...tablesFromSchema()]

/** Deep entry points that are nothing but raw surface, whatever they import. */
const RAW_MODULES = ['@sortiva/db/schema', '@sortiva/db/client']

const PACKAGE = '@sortiva/db'

/** Only `packages/db` itself owns the raw tables. */
const DEFAULT_ALLOW = ['packages/db/']

function normalise(filename) {
  return filename.split('\\').join('/')
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban raw table and database-handle imports from @sortiva/db outside packages/db, so no query can reach a table without naming an account (CLAUDE.md code-structure rules, tech §3).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allow: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      rawTable:
        'Raw `{{name}}` from @sortiva/db. Tables and the database handle may only be imported inside {{allow}}; everywhere else goes through a repository that takes an AccountScope. (CLAUDE.md code-structure rules, tech §3)',
      rawModule:
        'Raw `{{module}}` import. The schema and client modules may only be imported inside {{allow}}; everywhere else goes through a repository that takes an AccountScope. (CLAUDE.md code-structure rules, tech §3)',
    },
  },
  create(context) {
    const allow = context.options[0]?.allow ?? DEFAULT_ALLOW
    const filename = normalise(context.filename ?? context.getFilename())
    if (allow.some((dir) => filename.includes(dir))) return {}

    const raw = new Set(RAW_EXPORTS)
    const allowList = allow.join(', ')

    function report(node, messageId, data) {
      context.report({ node, messageId, data: { ...data, allow: allowList } })
    }

    return {
      ImportDeclaration(node) {
        const source = node.source.value
        if (typeof source !== 'string') return

        if (RAW_MODULES.some((m) => source === m || source.startsWith(`${m}/`))) {
          report(node, 'rawModule', { module: source })
          return
        }
        if (source !== PACKAGE) return

        // `import type { Db } from '@sortiva/db'` — a type executes nothing.
        if (node.importKind === 'type') return

        for (const spec of node.specifiers) {
          if (spec.type === 'ImportNamespaceSpecifier' || spec.type === 'ImportDefaultSpecifier') {
            // `import * as db` re-opens the whole raw surface behind a name.
            report(spec, 'rawTable', { name: '*' })
            continue
          }
          if (spec.type !== 'ImportSpecifier') continue
          if (spec.importKind === 'type') continue
          const name = spec.imported.name ?? spec.imported.value
          if (raw.has(name)) report(spec, 'rawTable', { name })
        }
      },
    }
  },
}
