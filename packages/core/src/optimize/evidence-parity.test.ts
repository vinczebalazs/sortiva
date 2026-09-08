import { describe, expect, it } from 'vitest'
import type { FactSheet } from '../distill/schema'
import { gradingEvidence } from './grading'
import type { CitableField, OptimizeEvidencePack } from './pack'
import { buildRecommendationRequest } from './recommendation'
import { PAGE_BODY, fixturePack } from './testing/fixture'

/**
 * The writing prompt and the grading evidence are assembled in two different
 * files, and for a while nothing compared them. The grader was given each
 * product's whole fact sheet while the writer got only the citable fields, so
 * the grader could confirm a claim — a price, most dangerously — against a
 * figure that was never in front of the model that wrote it.
 *
 * These tests hold both halves of the rule, and they pull in opposite
 * directions on purpose:
 *
 * - the grader is never shown a value the writer was not shown, or grounding
 *   stops meaning anything;
 * - the grader is still shown *less*, which is what keeps it a separate
 *   judgement rather than a re-run of the writing call.
 *
 * The first is written against values rather than field names, so it catches a
 * leak through any route — a new key, a nested object, a field added to the
 * fact sheet next month — not just the one that caused it.
 */

/** Fact-sheet fields a suggestion may not cite, and so may not be graded against either. */
type WithheldField = Exclude<keyof FactSheet, CitableField>

/**
 * A distinctive value for every withheld field. The mapped type is the point:
 * a new field on the fact sheet that is not added to the citable list fails to
 * compile here until somebody gives it a sentinel, rather than slipping through
 * untested.
 */
const WITHHELD: { readonly [K in WithheldField]: FactSheet[K] } = {
  variant_axes: ['Sentinel axis Wingspan'],
  price_range: { min: 1290.11, max: 2490.22 },
  fluff_discarded: true,
  fact_count: 987654,
}

interface Leaf {
  readonly path: string
  readonly value: string
}

/** Every primitive that survives serialisation, with the route it arrived by. */
function leaves(value: unknown, path = ''): Leaf[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => leaves(item, `${path}[${i}]`))
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) =>
      leaves(child, path === '' ? key : `${path}.${key}`),
    )
  }
  if (value === null || value === undefined) return []
  return [{ path, value: String(value) }]
}

const WITHHELD_SENTINELS = leaves(WITHHELD)
  .map((leaf) => leaf.value)
  // `true` is not distinctive enough to search a prompt for; the parity test below covers it.
  .filter((value) => value !== 'true' && value !== 'false')

function packWithEveryWithheldFieldFilled(): OptimizeEvidencePack {
  const base = fixturePack()
  return {
    ...base,
    products: base.products.map((product) => ({
      ...product,
      factSheet: { ...product.factSheet, ...WITHHELD },
    })),
  }
}

/** Everything the writing model is actually sent, as one string to search. */
function writerPrompt(pack: OptimizeEvidencePack): string {
  const request = buildRecommendationRequest({
    prompt: { version: 'optimize-reco.v1', text: 'The writing instructions.' },
    pack,
    limits: { titleMaxChars: 60, metaMaxChars: 155 },
  })
  return request.messages.map((message) => message.content).join('\n')
}

describe('OPTIMIZE writer and grader see the same evidence', () => {
  it('shows the grader no value the writer was not shown', () => {
    const pack = packWithEveryWithheldFieldFilled()
    const prompt = writerPrompt(pack)
    const shown = leaves(gradingEvidence(pack))

    // Guards against the check passing because the grader was handed nothing.
    expect(shown.length).toBeGreaterThan(10)

    const unseenByTheWriter = shown.filter((leaf) => !prompt.includes(leaf.value))
    expect(unseenByTheWriter).toEqual([])
  })

  it('keeps the price range, the option axes and the distillation flag away from the grader', () => {
    const serialised = JSON.stringify(gradingEvidence(packWithEveryWithheldFieldFilled()))

    expect(WITHHELD_SENTINELS.length).toBeGreaterThan(0)
    for (const sentinel of WITHHELD_SENTINELS) {
      expect(serialised).not.toContain(sentinel)
    }
  })

  it('still gives the grader the store facts the writer could cite', () => {
    const evidence = gradingEvidence(fixturePack())
    const serialised = JSON.stringify(evidence)

    expect(serialised).toContain('product:prod-ridge/material')
    expect(serialised).toContain('recycled mesh upper')
    expect(serialised).toContain('family:fam-trail/axis:width')
  })

  it('still withholds the writer\'s own context, which is what keeps the grading separate', () => {
    const serialised = JSON.stringify(gradingEvidence(fixturePack()))

    expect(serialised).not.toContain(PAGE_BODY.slice(0, 40))
    expect(serialised).not.toContain('A running shop for runners with wide feet.')
    expect(serialised).not.toContain('pages/fitting-guide')
    expect(serialised).not.toContain('8400')
  })
})
