import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { detectLocale, timezoneForCountry } from '@sortiva/core'
import { MockLlmClient } from '../mock'
import { personaEvalRunner, vocabularyOf, type PersonaEvalGold, type PersonaEvalInput } from './persona-runner'
import { discoverEvalSets, loadEvalSet, runEvalSet, type EvalRunnerRegistry } from './runner'

/**
 * `persona.smoke` itself runs on its own gate (`pnpm eval`) against the real
 * model, because grading a stand-in grades nothing.
 *
 * What runs *here*, on every merge, is the half of the set that needs no model
 * at all — and it is the half the card is actually graded on. A store's
 * language and country are decided by a chain of evidence rather than by the
 * model, so "language/country detection exact-match across the smoke set" is a
 * claim that can be checked now, on a machine with no key, and it is checked
 * here case by case. What needs the key is whether the model's *description*
 * describes anything, which is the one judgement no fixture can stand in for.
 */

const SET_DIR = fileURLToPath(new URL('../../eval/persona.smoke', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const set = loadEvalSet(SET_DIR)

function caseOf(id: string): { input: PersonaEvalInput; gold: PersonaEvalGold } {
  const found = set.cases.find((testCase) => testCase.id === id)
  if (!found) throw new Error(`no such case: ${id}`)
  return { input: found.input as PersonaEvalInput, gold: found.gold as PersonaEvalGold }
}

/** A model that returns a description naming the store's own first family. */
function describingClient(): MockLlmClient {
  const client = new MockLlmClient()
  client.setDefault('persona', (request) => {
    const brief = request.messages[0]?.content ?? ''
    const family = /^- (.+?) \(\d+ product\(s\)\)$/m.exec(brief)?.[1] ?? 'products'
    return JSON.stringify({
      business_description:
        `This shop sells ${family} and related equipment to people who use it regularly. ` +
        `The range is organised around a handful of families rather than a long list of near-identical items.`,
      product_categories: [family],
      // Deliberately wrong. The chain decides these, and the smoke set is what
      // proves the chain rather than the model is deciding them.
      main_language: 'xx',
      country: 'ZZ',
      audience: 'People who use this equipment regularly',
      brand_tone: 'plain',
    })
  })
  return client
}

function registryFor(client: MockLlmClient): EvalRunnerRegistry {
  return { persona: personaEvalRunner(client) }
}

describe('persona.smoke, the set itself', () => {
  it('holds ten known stores, each with an expected answer', () => {
    expect(set.config.name).toBe('persona.smoke')
    expect(set.config.metric).toBe('exact_match')
    expect(set.config.runner).toBe('persona')
    expect(set.config.promptVersion).toBe('persona.v1')
    expect(set.cases).toHaveLength(10)
  })

  it('is found by the discovery walk, so it cannot be a suite that silently does not run', () => {
    // The fixed name is `persona.smoke`, not `persona.eval`. A walk that only
    // recognised `.eval` would leave this set committed, reviewed and never
    // executed — which is exactly what an eval set must never look like.
    const names = discoverEvalSets(repoRoot).map((found) => found.config.name)
    expect(names).toContain('persona.smoke')
  })

  it('covers seven languages and both kinds of publish clock', () => {
    const golds = set.cases.map((testCase) => testCase.gold as PersonaEvalGold)
    expect(new Set(golds.map((gold) => gold.main_language)).size).toBeGreaterThanOrEqual(7)
    // Two of the five countries whose zone is a choice rather than a fact.
    expect(golds.map((gold) => gold.country)).toEqual(expect.arrayContaining(['US', 'BR']))
  })
})

describe('the language and country every case is graded on, decided without a model', () => {
  for (const testCase of set.cases) {
    const input = testCase.input as PersonaEvalInput
    const gold = testCase.gold as PersonaEvalGold

    it(`${testCase.id}: ${gold.main_language}/${gold.country} — ${input.note ?? ''}`, () => {
      const detection = detectLocale({
        ...(input.shop ? { shop: input.shop } : {}),
        ...(input.homepageHtml === undefined ? {} : { homepageHtml: input.homepageHtml }),
        domain: input.domain,
      })

      expect(detection.language).toBe(gold.main_language)
      expect(detection.country).toBe(gold.country)
      expect(timezoneForCountry(detection.country).timezone).toBe(gold.timezone)
    })
  }
})

describe('the runner, with the model stood in for', () => {
  it('returns exactly the gold answer for a case whose description is substantive', async () => {
    const { input, gold } = caseOf('001-de-wanderschuhe')
    const answer = await personaEvalRunner(describingClient())(input, set.config)
    expect(answer).toEqual(gold)
  })

  it('passes the whole set when the descriptions describe the store', async () => {
    const result = await runEvalSet(set, registryFor(describingClient()))
    expect(result.failures).toEqual([])
    expect(result.passed).toBe(true)
    expect(result.caseCount).toBe(10)
  })

  it('fails a case whose description would be true of any shop', async () => {
    const client = new MockLlmClient()
    client.setDefault('persona', () =>
      JSON.stringify({
        business_description:
          'This store offers a wide range of high-quality products for discerning customers. Everything is chosen with care and dispatched quickly.',
        product_categories: ['products'],
        main_language: 'de',
        country: 'DE',
        audience: 'Customers',
        brand_tone: 'premium',
      }),
    )

    const result = await runEvalSet(set, registryFor(client))
    expect(result.passed).toBe(false)
    expect(result.failures.length).toBeGreaterThan(0)
    expect(result.failures[0]).toContain('does not match gold exactly')
  })

  it('judges the description against the store’s own words, not the model’s', () => {
    const { input } = caseOf('001-de-wanderschuhe')
    // Family names and best sellers. Not the categories the answer returned —
    // grading an answer against another part of the same answer would let a
    // model agree with itself.
    expect(vocabularyOf(input)).toContain('wanderschuhe')
    expect(vocabularyOf(input)).toContain('trekkingstock')
  })

  it('refuses to grade a stand-in when no key is configured', async () => {
    const key = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const { input } = caseOf('001-de-wanderschuhe')
      await expect(personaEvalRunner()(input, set.config)).rejects.toThrow(/ANTHROPIC_API_KEY/)
    } finally {
      if (key !== undefined) process.env.ANTHROPIC_API_KEY = key
    }
  })
})
