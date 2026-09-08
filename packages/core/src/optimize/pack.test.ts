import { describe, expect, it } from 'vitest'
import { rules } from '@sortiva/rules'
import { lintRecommendation } from './lints'
import { packFactAddresses, packFacts, type OptimizeEvidencePack } from './pack'
import { buildRecommendationRequest } from './recommendation'
import { fixturePack, fixtureRecommendation } from './testing/fixture'

/**
 * What a suggestion is allowed to rest on, and one thing it is not.
 *
 * A product's option axes are the merchant's own words for the choices on their
 * product, and the fact sheet has carried them since the catalogue sync began
 * asking Shopify for them. They are still not evidence, because the sheet keeps
 * the axis *name* and drops its values: "Colour" is what a shop that sells one
 * black shoe and a shop that sells five colourways both store, so a suggestion
 * resting on it could promise the merchant's customers a choice that does not
 * exist. These tests hold that line, and the pack's own comment says why.
 */

const config = rules().defaults.gates.optimize_recommendation

/** The same store, with the axes its merchant really did fill in on Shopify. */
function packWithAxes(axes: readonly string[]): OptimizeEvidencePack {
  const base = fixturePack()
  const product = base.products[0]!
  return fixturePack({
    products: [{ ...product, factSheet: { ...product.factSheet, variant_axes: axes } }],
  })
}

describe('evidence pack facts', () => {
  it('offers no address for a product option axis, however many the store has', () => {
    const populated = packFacts(packWithAxes(['Size', 'Colour']))

    expect(populated.map((fact) => fact.address)).not.toContain('product:prod-ridge/variant_axes')
    for (const fact of populated) expect(fact.address).not.toContain('variant_axes')
  })

  it('leaves a store that fills those fields in exactly where a store that does not already is', () => {
    // The point of the pairing: populating the field must not move a single
    // address, value or label — otherwise "we ignore it" would be half true.
    expect(packFacts(packWithAxes(['Size', 'Colour']))).toEqual(packFacts(packWithAxes([])))
  })

  it('still lets a suggestion cite what tells a family apart', () => {
    // The exclusion is about one field, not about axes. A family's
    // differentiation axes are a comparison across products and stay citable.
    expect([...packFactAddresses(packWithAxes(['Size']))]).toContain('family:fam-trail/axis:width')
  })

  it('never shows the axis names to the model that writes the suggestions', () => {
    const request = buildRecommendationRequest({
      prompt: { version: 'optimize_reco.v1', text: 'SYSTEM' },
      pack: packWithAxes(['Size', 'Colour']),
      limits: { titleMaxChars: 60, metaMaxChars: 155 },
    })
    const sent = request.messages.map((message) => message.content).join('\n')

    expect(sent).not.toContain('Colour')
    expect(sent).not.toContain('variant_axes')
    // The rest of that product's sheet is there, so this is an exclusion rather
    // than a product the pack forgot.
    expect(sent).toContain('recycled mesh upper')
  })

  it('refuses a suggestion that cites an axis name as its evidence', () => {
    const result = lintRecommendation(
      fixtureRecommendation({
        sections: [
          {
            heading: 'Choosing your colour',
            suggested_copy: 'Every pair comes in a choice of colours, so pick the one you will wear most.',
            facts_used: ['product:prod-ridge/variant_axes'],
            gap_source: 'store',
          },
        ],
      }),
      { pack: packWithAxes(['Size', 'Colour']), config },
    )

    expect(result.passed).toBe(false)
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        check: 'grounding',
        detail: expect.stringContaining('product:prod-ridge/variant_axes'),
      }),
    )
  })
})
