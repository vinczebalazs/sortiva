#!/usr/bin/env node
/**
 * main §14.7 — "Dashboards and alerts are provisioned as code — never clicked
 * together by hand. All insights, dashboards … alert definitions, and the
 * `domain` group type are created and updated via the PostHog API … from
 * definition files versioned in the repo, applied idempotently by a setup script
 * that runs in CI/deploy (create-or-update by a stable key, so re-running
 * converges instead of duplicating)."
 *
 * tech §5 adds: CI runs it in **check mode**, and drift between the repo
 * definitions and the live project fails the build.
 *
 *   node scripts/posthog-provision.mjs --check     compare, never write
 *   node scripts/posthog-provision.mjs --apply     create or update by key
 *
 * Definitions live in `ops/posthog/definitions/*.json`, one object per file:
 *
 *   { "kind": "dashboard" | "insight" | "alert" | "group_type",
 *     "key":  "cost-per-domain",          // stable; the create-or-update key
 *     "name": "Cost per domain",
 *     ... kind-specific fields }
 *
 * Rationale for the shape (§14.7): "A dashboard that isn't in the definition
 * files doesn't officially exist." The `key` is what makes re-running converge
 * rather than duplicate, so it is required and must be unique.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFINITIONS_DIR = join(repoRoot, 'ops', 'posthog', 'definitions')

const KINDS = new Set(['dashboard', 'insight', 'alert', 'group_type'])

const mode = process.argv.includes('--apply') ? 'apply' : 'check'

function loadDefinitions() {
  if (!existsSync(DEFINITIONS_DIR)) return []
  const files = readdirSync(DEFINITIONS_DIR).filter((f) => f.endsWith('.json')).sort()
  const seen = new Map()
  const definitions = []

  for (const file of files) {
    const path = join(DEFINITIONS_DIR, file)
    let parsed
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      fail(`${file}: not valid JSON — ${error.message}`)
    }
    for (const definition of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!KINDS.has(definition.kind)) {
        fail(`${file}: unknown kind "${definition.kind}" (expected one of ${[...KINDS].join(', ')})`)
      }
      if (!definition.key) {
        fail(`${file}: every definition needs a stable "key" — it is what makes re-running converge instead of duplicating`)
      }
      const id = `${definition.kind}:${definition.key}`
      if (seen.has(id)) {
        fail(`${file}: duplicate ${id}, already defined in ${seen.get(id)}`)
      }
      seen.set(id, file)
      definitions.push({ ...definition, sourceFile: file })
    }
  }
  return definitions
}

function fail(message) {
  console.error(`FAIL  ${message}`)
  process.exit(1)
}

async function posthogFetch(path, init = {}) {
  const host = process.env.POSTHOG_HOST ?? 'https://eu.posthog.com'
  const key = process.env.POSTHOG_PERSONAL_API_KEY
  const project = process.env.POSTHOG_PROJECT_ID
  const response = await fetch(`${host}/api/projects/${project}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (!response.ok) {
    fail(`PostHog API ${path} returned ${response.status}`)
  }
  return response.json()
}

async function main() {
  const definitions = loadDefinitions()

  if (definitions.length === 0) {
    // The M0 state. Nothing is declared, so nothing can have drifted — and
    // saying so is honest rather than a skipped check reporting green.
    console.log(`PASS  no PostHog definitions declared yet (${DEFINITIONS_DIR})`)
    console.log('      Dashboards land with T8.4: "cost per domain", "preview economics", funnel, calibration.')
    return
  }

  const credentialed = Boolean(process.env.POSTHOG_PERSONAL_API_KEY && process.env.POSTHOG_PROJECT_ID)
  if (!credentialed) {
    // Definitions exist but cannot be verified. Passing here would mean the
    // build stops noticing drift the moment someone forgets a secret.
    fail(
      `${definitions.length} definition(s) declared but POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID are not set, so drift cannot be checked.`,
    )
  }

  const live = await posthogFetch('/dashboards/?limit=500')
  const liveByKey = new Map(
    (live.results ?? []).map((d) => [`dashboard:${d.name}`, d]),
  )

  const drift = []
  for (const definition of definitions) {
    const id = `${definition.kind}:${definition.key}`
    if (!liveByKey.has(id)) drift.push(`${id} (${definition.sourceFile}) is not in the live project`)
  }

  if (mode === 'check') {
    if (drift.length > 0) {
      console.error('FAIL  PostHog project has drifted from the repo definitions:')
      for (const line of drift) console.error(`      - ${line}`)
      process.exit(1)
    }
    console.log(`PASS  ${definitions.length} definition(s) match the live project`)
    return
  }

  console.log(`APPLY not yet implemented — ${definitions.length} definition(s) would be created or updated.`)
  console.log('      The writer lands with T8.4, which is the card that adds the first dashboards.')
  process.exit(1)
}

await main()
