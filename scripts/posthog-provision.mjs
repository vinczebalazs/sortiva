#!/usr/bin/env node
/**
 * Dashboards, insights and alerts are provisioned as code, never clicked
 * together by hand. This is the entry point; everything it decides lives in
 * `packages/providers/src/posthog/provision.ts`, beside its tests.
 *
 *   pnpm posthog:check          compare the project against the repo, never write
 *   pnpm posthog:apply          create or update by key; safe to run repeatedly
 *
 * Definitions live in `ops/posthog/definitions/*.json`. A chart nobody put in a
 * file there does not officially exist.
 *
 * **Without credentials**, check mode validates the files and says clearly that
 * it could not compare them with the live project. It does not pass silently
 * and it does not fail either: a workspace with no analytics secrets is the
 * normal case for everyone building, and a check that is red for everybody is a
 * check nobody reads. Where the comparison must actually happen — CI and
 * deploy, which do have the secrets — set `POSTHOG_REQUIRE_LIVE_CHECK=true` and
 * a missing key becomes a failure instead of a note.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFINITIONS_DIR = join(repoRoot, 'ops', 'posthog', 'definitions')
const RECIPIENTS_FILE = join(repoRoot, 'ops', 'posthog', 'alert-recipients.json')

const { loadDefinitions, loadRecipients, checkDrift, apply, HttpPosthogAdminApi, DefinitionError } =
  await import('../packages/providers/src/posthog/provision.ts')

const mode = process.argv.includes('--apply') ? 'apply' : 'check'

function fail(message) {
  console.error(`FAIL  ${message}`)
  process.exit(1)
}

let definitions
let recipients
try {
  definitions = loadDefinitions(DEFINITIONS_DIR)
  recipients = loadRecipients(RECIPIENTS_FILE)
} catch (error) {
  if (error instanceof DefinitionError) fail(error.message)
  throw error
}

if (definitions.length === 0) {
  console.log(`PASS  no definitions declared yet (${DEFINITIONS_DIR})`)
  process.exit(0)
}

const counts = {}
for (const definition of definitions) counts[definition.kind] = (counts[definition.kind] ?? 0) + 1
const summary = Object.entries(counts)
  .map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : 's'}`)
  .join(', ')

const host = process.env.POSTHOG_HOST ?? 'https://eu.posthog.com'
const personalApiKey = process.env.POSTHOG_PERSONAL_API_KEY
const projectId = process.env.POSTHOG_PROJECT_ID

if (!personalApiKey || !projectId) {
  const detail =
    'POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID are not set, so the live project could not be read'
  if (mode === 'apply') fail(`cannot apply: ${detail}.`)
  if (process.env.POSTHOG_REQUIRE_LIVE_CHECK === 'true') fail(`drift cannot be checked: ${detail}.`)
  console.log(`PASS  ${summary} are valid and internally consistent.`)
  console.log(`      NOT CHECKED against the live project: ${detail}.`)
  console.log('      Set POSTHOG_REQUIRE_LIVE_CHECK=true where that must be a failure (CI, deploy).')
  process.exit(0)
}

const api = new HttpPosthogAdminApi({ host, projectId, personalApiKey })

// A recipient nobody can find is a problem with the repo's files, said as one.
async function orFail(work) {
  try {
    return await work()
  } catch (error) {
    if (error instanceof DefinitionError) fail(error.message)
    throw error
  }
}

if (mode === 'check') {
  const drift = await orFail(() => checkDrift(api, definitions, { recipients }))
  if (drift.length > 0) {
    console.error(`FAIL  the analytics project has drifted from the repo (${drift.length}):`)
    for (const item of drift) console.error(`      - ${item.detail}`)
    process.exit(1)
  }
  console.log(`PASS  ${summary} match the live project`)
  process.exit(0)
}

const result = await orFail(() => apply(api, definitions, { recipients }))
console.log(
  `APPLIED  created ${result.created.length}, updated ${result.updated.length}, already correct ${result.unchanged.length}`,
)
for (const id of result.created) console.log(`  + ${id}`)
for (const id of result.updated) console.log(`  ~ ${id}`)
for (const skipped of result.skipped) console.log(`  · ${skipped.id} — ${skipped.why}`)
