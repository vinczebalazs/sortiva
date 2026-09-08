#!/usr/bin/env node
/**
 * `pnpm contracts:check` — build plan T0.7's done-when: "lists zero shape
 * mismatches between zod and OpenAPI".
 *
 * The OpenAPI document is generated from the zod route table, so a "mismatch"
 * is the committed file having drifted from the schemas — a hand-edit, or a
 * schema change nobody regenerated. Both are exactly the failure the check
 * exists to catch, and both are invisible without it.
 *
 * It also enforces two rules the route table cannot enforce on itself:
 * every route declares a response schema, and every conflict code in the enum
 * is returned by at least one route (dead contract surface the UI would build
 * a toast for and never see).
 *
 * And — added 2026-09-08, because until then it did not — it compares the table
 * to the **route files on disk**. Everything above compares the contract to
 * itself: the table to the document generated from the table. Ten endpoints
 * were once built at addresses the table did not know about, while the table
 * declared several nothing had ever implemented, and this check passed on every
 * run throughout. The walk itself lives in `packages/core/src/api/
 * routes-on-disk.ts` so that this script and the browser-side check that needs
 * the same answer cannot drift into two opinions about what is served.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const documentPath = join(repoRoot, 'packages', 'core', 'openapi.json')
const write = process.argv.includes('--write')

const { ROUTES, routeKey, unusedConflictCodes, UNCONTRACTED_ROUTES } = await import(
  '../packages/core/src/api/routes.ts'
)
const { routesOnDisk, patternFor } = await import('../packages/core/src/api/routes-on-disk.ts')
const { serialiseOpenApi, operationIdOf } = await import('../packages/core/src/api/openapi.ts')

const problems = []

// Every route must describe what it returns; an undocumented response is a
// contract the frontend has to guess at.
for (const route of ROUTES) {
  if (!route.response) problems.push(`${routeKey(route)}: no response schema`)
  if (!route.summary) problems.push(`${routeKey(route)}: no summary`)
}

// Operation ids must be unique, or generated clients collide silently.
const operationIds = new Map()
for (const route of ROUTES) {
  const id = operationIdOf(route)
  if (operationIds.has(id)) {
    problems.push(`duplicate operationId "${id}": ${operationIds.get(id)} and ${routeKey(route)}`)
  }
  operationIds.set(id, routeKey(route))
}

// Path + method must be unique.
const seen = new Set()
for (const route of ROUTES) {
  const key = routeKey(route)
  if (seen.has(key)) problems.push(`duplicate route ${key}`)
  seen.add(key)
}

const unused = unusedConflictCodes()
if (unused.length > 0) {
  problems.push(
    `conflict codes in the enum that no route returns: ${unused.join(', ')} — the UI would build a toast that never fires`,
  )
}

/**
 * The contract against the routes, both ways.
 *
 * A declared address with no file is an endpoint a screen will call and nothing
 * will answer. A served address the contract does not know about is an endpoint
 * nothing describes, nothing generates a client for, and no check in this file
 * has ever looked at. `UNCONTRACTED_ROUTES` names the addresses that are
 * deliberately outside the JSON contract — redirects, downloads, and the
 * identity library's own family — each with a reason, so "not in the table" and
 * "nobody built it" cannot look the same.
 */
const apiRoot = join(repoRoot, 'apps', 'web', 'app', 'api')
const served = routesOnDisk(apiRoot)

if (served.size === 0) {
  // A walk that finds nothing would silently agree with any contract at all.
  problems.push(`no route files found under ${apiRoot} — the routes-on-disk check would prove nothing`)
} else {
  const declared = [
    ...ROUTES.map((route) => ({ method: route.method, path: route.path })),
    ...UNCONTRACTED_ROUTES.flatMap((route) => {
      const [first = '', second] = route.path.split(' ')
      return second === undefined
        ? ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].map((method) => ({ method, path: first }))
        : [{ method: first, path: second }]
    }),
  ].map((route) => ({ ...route, pattern: patternFor(route.path) }))

  for (const address of served) {
    const [method = '', path = ''] = address.split(' ')
    const known = declared.some((route) => route.method === method && route.pattern.test(path))
    if (!known) {
      problems.push(
        `${address} is served by a route file and the contract does not declare it — add it to the ` +
          'route table, or to UNCONTRACTED_ROUTES with the reason it is outside the JSON contract',
      )
    }
  }

  for (const route of ROUTES) {
    const key = routeKey(route)
    // A parameterised path is served by one file whose directory carries the
    // brackets, so compare on the contract spelling rather than the address.
    if (!served.has(`${route.method} ${route.path}`)) {
      problems.push(
        `${key} is declared in the contract and no route file serves it — a screen calling it ` +
          'would reach nothing',
      )
    }
  }
}

let generated
try {
  generated = serialiseOpenApi()
} catch (error) {
  console.error(`FAIL  could not generate the OpenAPI document: ${error.message}`)
  process.exit(1)
}

if (write) {
  writeFileSync(documentPath, generated)
  console.log(`WROTE ${documentPath} (${ROUTES.length} routes)`)
} else if (!existsSync(documentPath)) {
  problems.push('packages/core/openapi.json is missing — run `pnpm contracts:check --write`')
} else if (readFileSync(documentPath, 'utf8') !== generated) {
  problems.push(
    'packages/core/openapi.json has drifted from the zod schemas — run `pnpm contracts:check --write` and commit the result',
  )
}

if (problems.length > 0) {
  console.error(`FAIL  ${problems.length} contract problem(s):`)
  for (const problem of problems) console.error(`      - ${problem}`)
  process.exit(1)
}

console.log(
  `PASS  ${ROUTES.length} routes; zod and OpenAPI agree; ${served.size} served by route files and all accounted for; no dead conflict codes`,
)
