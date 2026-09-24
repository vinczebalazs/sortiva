import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CRON_ENTRIES } from './crontab'

/**
 * Every job the product registers is either on the clock or has something that
 * asks for it. Neither is optional: a job with no schedule and no caller is
 * work that will never happen, and it looks exactly like work that is happening.
 *
 * Three findings in the remediation ledger are that same shape — a handler
 * registered, correct, tested, and reachable by nothing. The onboarding retry
 * was one of them; the weekly intent-gap comparison is another. This closes the
 * class rather than the instances: a new job that nobody wired up fails here on
 * the day it is written.
 *
 * It reads the source rather than the live registry because registration
 * happens in the process's composition root, against concrete infrastructure —
 * a database, a Shopify client, a token cipher — that a unit test has no
 * business building. What the source can be asked, reliably, is which names are
 * registered and which names something enqueues.
 *
 * **What it cannot see:** a job enqueued from outside this repository, and a
 * caller that builds a task name at runtime instead of naming a constant. The
 * second is worth knowing about; there are none today, and a job added that way
 * would show up here as unreachable, which is a loud wrong answer rather than a
 * quiet one.
 */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const SEARCHED = ['packages/jobs/src', 'apps/web/app', 'apps/web/instrumentation-node.ts']

function sourceFiles(): string[] {
  const found: string[] = []
  const walk = (path: string): void => {
    const stats = statSync(path, { throwIfNoEntry: false })
    if (!stats) return
    if (stats.isFile()) {
      if (path.endsWith('.ts') && !path.endsWith('.d.ts')) found.push(path)
      return
    }
    for (const entry of readdirSync(path)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue
      walk(join(path, entry))
    }
  }
  for (const dir of SEARCHED) walk(join(ROOT, dir))
  return found
}

const FILES = sourceFiles().map((path) => ({ path, text: readFileSync(path, 'utf8') }))

/** `export const FOO_TASK = 'foo'` — the one shape every task name is declared in. */
function taskConstants(): Map<string, string> {
  const names = new Map<string, string>()
  for (const file of FILES) {
    for (const match of file.text.matchAll(/export const (\w+) = '([a-z0-9_]+)'/g)) {
      names.set(match[1]!, match[2]!)
    }
  }
  return names
}

const CONSTANTS = taskConstants()

/** Identifiers handed to `registerTask`, across both the one-line and wrapped forms. */
function registeredIdentifiers(): Map<string, string> {
  const registered = new Map<string, string>()
  for (const file of FILES) {
    if (file.path.endsWith('runtime/tasks.ts')) continue
    for (const match of file.text.matchAll(/registerTask\(\s*(\w+)\s*,/g)) {
      const identifier = match[1]!
      const name = CONSTANTS.get(identifier)
      if (name) registered.set(name, file.path.slice(ROOT.length))
    }
  }
  return registered
}

/**
 * Names something puts on the queue. Every enqueue in this codebase is a
 * `graphile_worker.add_job` call whose first argument is either a task constant
 * or a local `task` holding one.
 */
function enqueuedNames(): Set<string> {
  const enqueued = new Set<string>()
  for (const file of FILES) {
    if (!file.text.includes('add_job(')) continue
    for (const match of file.text.matchAll(/add_job\(\s*\$\{(\w+)\}/g)) {
      const identifier = match[1]!
      if (identifier === 'task') continue
      const name = CONSTANTS.get(identifier)
      if (name) enqueued.add(name)
    }
    // The `const task = X` form, used where one helper builds several payloads.
    for (const match of file.text.matchAll(/const task = (\w+)\b/g)) {
      const name = CONSTANTS.get(match[1]!)
      if (name) enqueued.add(name)
    }
  }
  return enqueued
}

/**
 * Jobs known to be unreachable, each with the reason it has not simply been
 * wired up. **A record is not permission.** Every entry is asserted to still be
 * unreachable, so the day somebody fixes one this file turns red asking for the
 * entry to be deleted — an admission that is no longer true is worse than none.
 */
const UNREACHABLE: Readonly<Record<string, string>> = {
  intent_gap_scan_weekly:
    'Registered, correct, and started by nothing — the finding at ' +
    'packages/jobs/src/optimize/intent-gap-tasks.ts:139. Not fixed here because scheduling it is ' +
    'not a one-line change: the pass buys search data every week and the same ledger records that ' +
    'it runs with no billing, vacation or deletion gate, so putting it on the clock as it stands ' +
    'would spend money for stores that have stopped, been paused, or asked to be deleted.',
}

describe('every registered job can actually be reached', () => {
  const registered = registeredIdentifiers()
  const scheduled = new Set(CRON_ENTRIES.map((entry) => entry.task))
  const enqueued = enqueuedNames()

  it('finds the registrations at all, so an empty scan cannot pass', () => {
    // A source scan that matches nothing is the failure this whole file is
    // about, one level up.
    expect(registered.size).toBeGreaterThan(20)
    expect(enqueued.size).toBeGreaterThan(5)
  })

  it.each([...registered.entries()])('%s is scheduled or enqueued', (name, where) => {
    const reachable = scheduled.has(name) || enqueued.has(name)
    const recorded = UNREACHABLE[name]

    if (recorded) {
      expect(
        reachable,
        `\`${name}\` is recorded above as unreachable and now is reachable. Delete its entry: a ` +
          'record of a defect that has been fixed reads as a defect that has not.',
      ).toBe(false)
      return
    }

    expect(
      reachable,
      `\`${name}\` is registered in ${where} and nothing can start it: it is on no crontab and ` +
        'nothing enqueues it. Either add a crontab entry, or add the call site that asks for it — ' +
        'a handler nobody can reach is work that silently never happens.',
    ).toBe(true)
  })

  it('schedules nothing that is not registered', () => {
    // The worker already refuses to start on this, which is the real guard.
    // Asserted here too so the reason is stated once in a place a reader of
    // this file will find it.
    const orphans = [...scheduled].filter((task) => !registered.has(task))
    expect(orphans).toEqual([])
  })
})
