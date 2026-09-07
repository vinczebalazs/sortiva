import { describe, expect, it } from 'vitest'
import { loadPrompt } from '@sortiva/llm/prompts'
import { DRAFT_PROMPT_MAJOR_VERSION } from './prompts'

/**
 * The writing prompt is loaded at the version the product actually asks with
 * rather than a version named here, because a prompt nobody ships is a prompt
 * nothing can be proved about.
 */
const prompt = loadPrompt('draft', DRAFT_PROMPT_MAJOR_VERSION)

/**
 * Four kinds of claim used to be caught by English word lists in the gate, and
 * are now asked for here instead — which makes this prompt the only thing
 * standing behind them. If the instruction goes missing in a later version,
 * nothing else in the product would notice: the gate's own checks find figures
 * by shape and were never able to see these four.
 */
describe('the writing prompt carries the citation bar the gate no longer enforces', () => {
  it.each(['superlative', 'absolute', 'attributed statement', 'comparison'])(
    'asks for a citation on a %s',
    (kind) => {
      expect(prompt.text.toLowerCase()).toContain(kind)
    },
  )

  it('asks for it in the language the article is written in, not in English', () => {
    expect(prompt.text).toContain('whatever language you are writing in')
  })
})
