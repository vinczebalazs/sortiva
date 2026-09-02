import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OPPORTUNITY_ACTIONS } from '../contracts/opportunities'
import * as signals from './index'

/**
 * A signal is never mapped straight onto an action.
 *
 * The same observation warrants different work depending on what else is true.
 * A page losing traffic because it has gone stale wants rewriting; the same
 * page losing traffic because Google stopped indexing it wants the indexing
 * fixed, and rewriting it would waste the slot and leave the real cause in
 * place. A store already ranking for a search wants its existing page improved,
 * never a second page of its own competing with the first.
 *
 * So detection answers "what is true" and something else, later, decides "what
 * to do" from the whole picture. This test is the structural half of that: if
 * anyone ever writes an action into a detector, it fails here rather than in a
 * review that might not happen.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

function sourceFiles(): string[] {
  return readdirSync(HERE)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !name.endsWith('.test.ts'))
    .filter((name) => name !== 'testing.ts')
    .sort()
}

describe('detection never names an action', () => {
  it('has source files to check — an empty sweep proves nothing', () => {
    expect(sourceFiles().length).toBeGreaterThan(4)
  })

  for (const file of sourceFiles()) {
    it(`${file} contains none of the action names`, () => {
      const source = readFileSync(join(HERE, file), 'utf8')
      for (const action of OPPORTUNITY_ACTIONS) {
        expect(source).not.toMatch(new RegExp(`\\b${action}\\b`))
      }
    })
  }

  it('exports no function whose name suggests it chooses one', () => {
    const suspicious = Object.keys(signals).filter((name) =>
      /action|recommend|decide/i.test(name),
    )
    expect(suspicious).toEqual([])
  })
})
