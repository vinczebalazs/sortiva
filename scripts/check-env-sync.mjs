#!/usr/bin/env node
/**
 * `.env.example` documents every required variable (tech §4) and `.env` mirrors
 * it key-for-key. This fails the moment the two drift, so a new variable can
 * never land in one file only.
 *
 * `.env` is gitignored, so this is a no-op where it does not exist (CI).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function keysOf(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.match(/^([A-Z0-9_]+)=/))
    .filter(Boolean)
    .map((m) => m[1])
}

const examplePath = join(repoRoot, '.env.example')
const envPath = join(repoRoot, '.env')

if (!existsSync(envPath)) {
  console.log('SKIP  no .env in this environment (expected in CI)')
  process.exit(0)
}

const example = keysOf(examplePath)
const env = keysOf(envPath)

const missingInEnv = example.filter((k) => !env.includes(k))
const missingInExample = env.filter((k) => !example.includes(k))

if (missingInEnv.length === 0 && missingInExample.length === 0) {
  console.log(`PASS  .env and .env.example both declare ${example.length} variables`)
  process.exit(0)
}

if (missingInEnv.length) console.error(`FAIL  missing from .env:         ${missingInEnv.join(', ')}`)
if (missingInExample.length) console.error(`FAIL  missing from .env.example: ${missingInExample.join(', ')}`)
process.exit(1)
