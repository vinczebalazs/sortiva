import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DESIGN_TOKENS, tokenValue } from './tokens'

const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8')

/**
 * The token table and the stylesheet are two copies of the same set of values.
 * A component reads the stylesheet; a chart reads the table. If they drift, a
 * screen renders one colour and its chart another, and nobody notices until a
 * designer does.
 */
describe('the token table and the stylesheet agree', () => {
  for (const token of DESIGN_TOKENS) {
    it(`declares ${token.cssVar}`, () => {
      expect(css).toContain(`${token.cssVar}: ${token.value};`)
    })
  }

  it('declares nothing the table does not describe', () => {
    const declared = [...css.matchAll(/(--sortiva-[\w-]+):/g)].map((m) => m[1])
    const described = DESIGN_TOKENS.map((token) => token.cssVar)
    expect([...new Set(declared)].sort()).toEqual([...described].sort())
  })
})

describe('the canvas naming is traceable', () => {
  it('records the design canvas variable every token came from', () => {
    expect(DESIGN_TOKENS.every((token) => token.canvasVar.startsWith('--'))).toBe(true)
    expect(new Set(DESIGN_TOKENS.map((t) => t.canvasVar)).size).toBe(DESIGN_TOKENS.length)
  })

  it('looks a value up by the canvas name a designer would use', () => {
    expect(tokenValue('--pri')).toBe('#6470f3')
  })

  it('refuses a canvas name that is not in the set', () => {
    expect(() => tokenValue('--nope')).toThrow(/No design token/)
  })
})
