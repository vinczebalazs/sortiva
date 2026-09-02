import { describe, expect, it } from 'vitest'
import { rollUpRichness } from './richness'

/** The values `packages/rules` carries under `gates.substance_floor` today. */
const THRESHOLDS = { populatedFieldsPerProductMin: 4, marginMultiple: 1.5 }

function store(...populated: number[]) {
  // Fact counts track populated fields here; the band reads only the latter.
  return populated.map((n) => ({ populatedFields: n, factCount: n }))
}

describe('rollUpRichness', () => {
  it('calls a catalogue whose typical page states plenty "rich"', () => {
    const richness = rollUpRichness(store(6, 7, 8, 9, 10), THRESHOLDS)
    expect(richness.band).toBe('rich')
    expect(richness.medianPopulatedFields).toBe(8)
    expect(richness.productsMissingDetails).toBe(0)
    expect(richness.score).toBe(8)
  })

  it('calls a catalogue at the floor "okay"', () => {
    const richness = rollUpRichness(store(3, 4, 5), THRESHOLDS)
    expect(richness.band).toBe('okay')
    expect(richness.productsMissingDetails).toBe(1)
  })

  it('calls a catalogue below the floor "sparse"', () => {
    const richness = rollUpRichness(store(0, 1, 2, 3), THRESHOLDS)
    expect(richness.band).toBe('sparse')
    expect(richness.productsMissingDetails).toBe(4)
  })

  it('is not fooled by a handful of rich products among many bare ones', () => {
    // Twenty well-described products in two hundred: the average clears the
    // floor, the typical page does not.
    const catalogue = store(...Array(180).fill(1), ...Array(20).fill(10))
    const richness = rollUpRichness(catalogue, THRESHOLDS)
    expect(richness.score).toBeGreaterThan(richness.medianPopulatedFields)
    expect(richness.band).toBe('sparse')
    expect(richness.productsMissingDetails).toBe(180)
  })

  it('knows nothing about a store nothing has been distilled for', () => {
    expect(rollUpRichness([], THRESHOLDS)).toEqual({
      productsScored: 0,
      productsMissingDetails: 0,
      medianPopulatedFields: 0,
      score: 0,
      band: 'sparse',
    })
  })
})
