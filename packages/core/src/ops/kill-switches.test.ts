import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KILL_SWITCHES, killSwitch, reviewFinding, reviewReset } from './kill-switches'

/**
 * The vocabulary of switches, and the one place it is allowed to disagree with
 * itself.
 */

describe('the catalogue of switches', () => {
  it('names every switch the spec does, and says what each one stops', () => {
    for (const definition of KILL_SWITCHES) {
      expect(definition.stops.length).toBeGreaterThan(20)
      // Reading is never taken away. Nothing here may describe itself as
      // closing a screen or revoking access.
      expect(definition.stops).not.toMatch(/revoke|read access|log ?in|sign ?in/i)
    }
    expect(KILL_SWITCHES.map((s) => s.flag)).toEqual(
      expect.arrayContaining([
        'global.pause_all',
        'global.pause_publishing',
        'account.pause_generation',
        'account.pause_publishing',
      ]),
    )
  })

  it('requires two operators for every global switch and one for every account switch', () => {
    for (const definition of KILL_SWITCHES) {
      expect(definition.resetNeedsTwoOperators).toBe(definition.scope === 'global')
    }
  })

  it('agrees with the preview module about what its switch is called', () => {
    // Nothing outside the preview may *import* from it — the ban is what keeps
    // throwaway preview output out of the real pipeline — so the catalogue
    // carries its own copy of the name and this reads the other one as text.
    // A pin, with no dependency: if either side is renamed, this fails.
    const limits = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'preview', 'limits.ts'),
      'utf8',
    )
    const declared = /PREVIEW_PAUSED_FLAG = '([^']+)'/.exec(limits)?.[1]

    expect(declared).toBeDefined()
    expect(killSwitch(declared!)).toBeDefined()
  })
})

describe('lowering a switch', () => {
  it('refuses a flag this product does not raise, rather than inventing one', () => {
    expect(reviewReset({ flag: 'global.pause_everything_forever', operator: 'alice' })).toMatchObject(
      { ok: false, code: 'unknown_flag' },
    )
  })

  it('refuses a blank operator, because every flip is recorded with who did it', () => {
    expect(reviewReset({ flag: 'account.pause_generation', operator: '  ' })).toMatchObject({
      ok: false,
      code: 'automatic_actor',
    })
  })

  it('records both names when two operators agree', () => {
    expect(
      reviewReset({ flag: 'global.pause_all', operator: ' alice ', secondOperator: ' bob ' }),
    ).toEqual({ ok: true, resetBy: 'alice + bob' })
  })
})

describe('writing down what an operator found', () => {
  it('refuses an unsigned note, because the value of a finding is being able to go back to whoever found it', () => {
    expect(reviewFinding({ author: '  ', finding: 'a vendor was retrying in a loop' })).toMatchObject(
      { ok: false, code: 'missing_author' },
    )
  })

  it('refuses the product as an author: it does not investigate itself', () => {
    expect(reviewFinding({ author: 'auto', finding: 'a vendor was retrying in a loop' })).toMatchObject(
      { ok: false, code: 'automatic_actor' },
    )
  })

  it('refuses an empty note, which records that somebody looked and nothing about what they saw', () => {
    expect(reviewFinding({ author: 'alice', finding: '   ' })).toMatchObject({
      ok: false,
      code: 'empty_finding',
    })
  })

  it('takes one name even on a global incident: saying what you saw is not declaring it over', () => {
    expect(reviewFinding({ author: ' alice ', finding: ' the vendor was down ' })).toEqual({
      ok: true,
      author: 'alice',
      finding: 'the vendor was down',
    })
  })
})
