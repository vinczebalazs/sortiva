import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { rules } from './load'
import { assertOverridableKey } from './overrides'
import { RULES_REACH, reachOf, thresholdPaths } from './reach'

/**
 * The reach table says, for every number the product judges by, whether an
 * operator moving it for one store actually changes anything. It is what the
 * operator command refuses against, so a gap in it is an operator being told
 * "done" about a change that will never happen.
 *
 * These hold the two properties a hand-kept table can be held to. It cannot be
 * proved still *true* — that a reader honours what the table says it honours is
 * held by the tests beside those readers — but it can be proved *complete*, and
 * that every path it names is a real one.
 */
describe('the reach table', () => {
  const defaults = rules().defaults

  it('classifies every number in the config file', () => {
    const unclassified = thresholdPaths(defaults).filter((path) => reachOf(path) === undefined)
    expect(unclassified).toEqual([])
  })

  it('names only paths the config file actually has', () => {
    for (const entry of RULES_REACH) {
      // A prefix may name a group; `assertOverridableKey` refuses a group, so
      // reaching into the layer is the check available here.
      const segments = entry.prefix.split('.')
      let cursor: unknown = defaults
      for (const segment of segments) {
        expect(cursor, `${entry.prefix} names nothing`).toBeTypeOf('object')
        cursor = (cursor as Record<string, unknown>)[segment]
      }
      expect(cursor, `${entry.prefix} names nothing`).toBeDefined()
    }
  })

  it('takes the narrowest entry that covers a key', () => {
    // Both `gates` and `gates.substance_floor` cover this one, and they
    // disagree; the narrower has to win or the command would let a partly
    // honoured number through as if every reader saw it.
    expect(reachOf('gates.winnability.minimum')?.reach).toBe('honoured')
    expect(reachOf('gates.substance_floor.distinct_facts_min')?.reach).toBe('partial')
    expect(reachOf('learning.refresh.cooldown_days')?.reach).toBe('honoured')
    expect(reachOf('learning.refresh.batch_share_max')?.reach).toBe('ignored')
  })

  it('says something an operator can act on for every entry', () => {
    for (const entry of RULES_REACH) {
      expect(entry.note.length, `${entry.prefix} has no note`).toBeGreaterThan(40)
    }
  })

  it('agrees with the check that refuses a key naming no threshold', () => {
    // A path the table classifies but the override validator refuses would be a
    // refusal message about a key that could never be set anyway.
    for (const path of thresholdPaths(defaults)) {
      expect(() => assertOverridableKey(defaults, path)).not.toThrow()
    }
  })
})

/**
 * The command an operator actually types, driven end to end.
 *
 * The defect these close is a person setting a number, being told it worked,
 * and nothing changing — so the check that matters is the refusal itself, not
 * the table behind it. Run against a database address that does not answer: a
 * refusal happens before anything is read or written, so a run that reaches the
 * database is a run that was not refused.
 */
describe('the operator command, refusing against the table', () => {
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

  function runSet(key: string, extra: readonly string[] = []): string {
    try {
      execFileSync(
        join(repoRoot, 'node_modules/.bin/tsx'),
        [
          join(repoRoot, 'scripts/rules-override.mjs'),
          'set',
          key,
          '5',
          '--actor',
          'tester',
          '--account',
          '11111111-1111-4111-8111-111111111111',
          ...extra,
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: 'pipe',
          env: { ...process.env, DATABASE_URL: 'postgres://unused@127.0.0.1:1/none' },
        },
      )
      return ''
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string }
      return `${failed.stdout ?? ''}${failed.stderr ?? ''}`
    }
  }

  it('refuses a number no reader would take from the row, and says what reads it', () => {
    const output = runSet('clusters.window_days')
    expect(output).toContain('Nothing would read')
    expect(output).toContain('Nothing was written.')
    expect(output).toContain('nightly clustering pass')
  })

  it('refuses a number only half the readers take from the row, and offers the way through', () => {
    const output = runSet('gates.substance_floor.distinct_facts_min')
    expect(output).toContain('is only read from a store')
    expect(output).toContain('Pass --partial')
    expect(output).toContain('Nothing was written.')
  })

  it('lets that same number through once --partial says the operator has read why', () => {
    const output = runSet('gates.substance_floor.distinct_facts_min', ['--partial'])
    expect(output).not.toContain('Nothing was written.')
  })

  it('does not stand in the way of a number every reader honours', () => {
    const output = runSet('gates.winnability.minimum')
    expect(output).not.toContain('Nothing was written.')
  })
}, 60_000)
