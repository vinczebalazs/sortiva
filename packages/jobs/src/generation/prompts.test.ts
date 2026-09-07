import { describe, expect, it } from 'vitest'
import { loadPrompt } from '@sortiva/llm/prompts'
import { DRAFT_PROMPT_MAJOR_VERSION, JUDGE_PROMPT_MAJOR_VERSION } from './prompts'

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

/**
 * The grading prompt, at the version the product asks with, for the same
 * reason.
 *
 * The grader writes one sentence per criterion saying why it scored what it
 * scored, and those sentences are shown to the merchant as-is when we hold
 * their article back. Every other word around them is English — the interface
 * ships in English only — so a sentence arriving in the store's own language
 * would produce a card that changes language halfway through. Nothing
 * downstream can repair that: the sentence is passed on verbatim, and there is
 * no second place where a language could be enforced.
 */
const judge = loadPrompt('judge', JUDGE_PROMPT_MAJOR_VERSION)

describe('the grading prompt fixes the language of the answer, not of the grading', () => {
  it('asks for the written objections in English, whatever the article is in', () => {
    expect(judge.text).toContain('Write those sentences in English, always')
    expect(judge.text).toContain('written in another language')
  })

  it('still grades the article in the language it was written in', () => {
    expect(judge.text).toContain('Grade the language it is written in, not a translation of it')
    expect(judge.text).toContain('never translate it')
  })

  it('says the same thing to every store, because nothing in it varies', () => {
    // No `{{placeholder}}` anywhere: the grader is told the same thing about a
    // Danish article as about an English one, so the English rule cannot be
    // switched off for the stores it is there for.
    expect(judge.text).not.toMatch(/\{\{/)
  })

  it('still asks for the six criteria and says nothing about where the floors are', () => {
    for (const criterion of [
      'informationGain',
      'factualGrounding',
      'searchIntentMatch',
      'actionability',
      'languageQuality',
      'ecommerceUsefulness',
    ]) {
      expect(judge.text).toContain(criterion)
    }
    expect(judge.text).toContain('Score each criterion from 1 to 5')
  })
})
