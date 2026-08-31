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
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const documentPath = join(repoRoot, 'packages', 'core', 'openapi.json')
const write = process.argv.includes('--write')

const { ROUTES, routeKey, unusedConflictCodes } = await import('../packages/core/src/api/routes.ts')
const { serialiseOpenApi, operationIdOf } = await import('../packages/core/src/api/openapi.ts')

const problems = []

// Every route must describe what it returns; an undocumented response is a
// contract the frontend has to guess at.
for (const route of ROUTES) {
  if (!route.response) problems.push(`${routeKey(route)}: no response schema`)
  if (!route.summary) problems.push(`${routeKey(route)}: no summary`)
  if (!route.spec) problems.push(`${routeKey(route)}: no spec citation`)
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

console.log(`PASS  ${ROUTES.length} routes; zod and OpenAPI agree; no dead conflict codes`)
