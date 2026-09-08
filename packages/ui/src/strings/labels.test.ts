import { describe, expect, it } from 'vitest'
import { renderTemplatedLine } from '../opportunities/why'
import { criteriaNamed, criterionLabel } from './labels'
import { t } from './translate'

/**
 * The names a merchant reads for the things the judge scores.
 *
 * The article page has named these in English since it was built. The sentence
 * explaining a held calendar day did not: it printed whatever the gate recorded,
 * which is the judge's own identifiers, so a merchant read "didn't meet our bar
 * on informationGain". Two surfaces naming the same thing, one of them wrong,
 * is the fault these tests hold shut — so they check the lookup and the
 * rendered sentence, not only the lookup.
 */

describe('a criterion, named for a merchant', () => {
  it('reads as English where the catalogue has wording', () => {
    expect(criterionLabel('informationGain')).toBe('Information gain')
    expect(criterionLabel('factualGrounding')).toBe('Factual grounding')
  })

  it('spells out one it has never heard of rather than showing a code', () => {
    // A criterion added to the judge before its wording is written should read
    // ungainly, not machine-generated.
    expect(criterionLabel('narrative_flow')).toBe('Narrative flow')
  })
})

describe('the criteria a draft fell short on', () => {
  it('names each one, from a value the gate joined before sending it', () => {
    expect(criteriaNamed('informationGain, factualGrounding')).toBe(
      'Information gain, Factual grounding',
    )
  })

  it('reads correctly for a single name, and would for a list', () => {
    // Nothing here depends on the joining: the day the gate sends a list
    // instead, only the split goes.
    expect(criteriaNamed('informationGain')).toBe('Information gain')
    expect(criteriaNamed('informationGain,factualGrounding')).toBe(
      'Information gain, Factual grounding',
    )
  })

  it('says nothing rather than something wrong when the gate recorded none', () => {
    expect(criteriaNamed('')).toBe('')
  })
})

/**
 * The end of the path, which is the part that was wrong on screen.
 *
 * The lookup existed and was correct throughout; what was missing was anything
 * calling it on the way to the calendar. These render the real sentences
 * through the real renderer.
 */
describe('the sentence a merchant reads when the quality bar held their article', () => {
  it('names the criterion in English, not in the grader\'s field name', () => {
    const line = renderTemplatedLine({
      templateKey: 'gate3.below_quality_bar',
      params: { failed_criteria: 'informationGain', first_justification: 'It restates the sources.' },
    })

    expect(line.text).toContain('Information gain')
    expect(line.text).not.toContain('informationGain')
  })

  it('does the same when more than one criterion fell short', () => {
    const line = renderTemplatedLine({
      templateKey: 'gate3.below_quality_bar',
      params: { failed_criteria: 'informationGain, factualGrounding', first_justification: '' },
    })

    expect(line.text).toContain('Information gain, Factual grounding')
    expect(line.text).not.toContain('informationGain')
    expect(line.text).not.toContain('factualGrounding')
  })

  it('leaves a sentence with no criterion in it exactly as it was', () => {
    // The mapping must not touch the eleven other gate sentences, which carry
    // measurements rather than names.
    const line = renderTemplatedLine({
      templateKey: 'gate1.rejected_off_catalog',
      params: { keyword: 'informationGain' },
    })

    expect(line.text).toBe(t('gate1.rejected_off_catalog', { keyword: 'informationGain' }))
  })
})
