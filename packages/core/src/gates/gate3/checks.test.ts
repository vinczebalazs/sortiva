import { describe, expect, it } from 'vitest'
import { rules } from '@sortiva/rules'
import type { ClaimPlan } from '../../generation/claims'
import type { Draft } from '../../generation/draft'
import { checkableKindsIn } from './checkable'
import { checkCitations } from './citations'
import { candidateConflicts, extractStatements } from './contradictions'
import { checkNearDuplicate, similarityAgainst } from './duplication'
import { keywordDensity } from './lints'
import { sentencesIn } from './prose'
import { checkAssertionStrength } from './strength'
import { checkStructure } from './structure'
import { claimIdFor, fixturePack, fixturePlan, passingDraft } from './testing'

const config = rules().defaults
const pack = fixturePack()
const plan = fixturePlan(pack)

function draftWith(sections: Draft['sections'], overrides: Partial<Draft> = {}): Draft {
  const base = passingDraft(plan)
  return { ...base, sections: [...base.sections, ...sections], ...overrides }
}

describe('sentence boundaries', () => {
  it('does not split a decimal in half', () => {
    expect(sentencesIn('The pack weighs 1.5 kg. It fits a laptop.')).toEqual([
      'The pack weighs 1.5 kg.',
      'It fits a laptop.',
    ])
  })

  it('keeps a citation marker with the sentence it belongs to', () => {
    expect(sentencesIn('It holds 20 litres[[c3]]. Nothing else.')).toEqual(['It holds 20 litres[[c3]].', 'Nothing else.'])
  })
})

describe('what counts as checkable content', () => {
  it.each([
    ['The pack holds 20 litres.', 'measurement'],
    ['Returns are up 15% this year.', 'percentage'],
    ['The coating lasts three years.', 'duration'],
    ['It comes in 3 colours.', 'number'],
  ])('finds %s', (sentence, kind) => {
    expect(checkableKindsIn(sentence)).toContain(kind)
  })

  /**
   * The same figures in Danish. Nothing about this detector is English, and
   * this is the case that proves it: a store publishing in Danish has its
   * figures caught exactly as an English store's are, with no list of Danish
   * words anywhere.
   *
   * The unit names are the one place the two differ, and it costs nothing that
   * matters: "3 år" is read as a bare number rather than as a duration,
   * because "år" is not one of the unit words. It is still checkable content,
   * so the citation is still compulsory — only the label on the failure
   * message is less specific.
   */
  it.each([
    ['Rygsækken rummer 20 liter.', 'measurement'],
    ['Returneringer er steget 15% i år.', 'percentage'],
    ['Belægningen holder 3 år.', 'number'],
  ])('finds the same by shape in Danish: %s', (sentence, kind) => {
    expect(checkableKindsIn(sentence)).toContain(kind)
  })

  it.each([
    'Work out how you actually walk, then narrow down from there.',
    'The fabric wears in rather than out.',
    'It is carried every day, which changes what matters.',
    'One day you will want something bigger.',
  ])('leaves ordinary prose alone: %s', (sentence) => {
    expect(checkableKindsIn(sentence)).toEqual([])
  })

  /**
   * A superlative, an absolute, an attribution and a comparison — in English,
   * where a word list used to catch all four. The detector is silent on them
   * now **by design**: recognising them needed a list of words in one
   * language, which held an English store to a bar a Danish store was never
   * held to. The citation they need is asked for in the writing prompt
   * instead, in whatever language the store publishes in.
   */
  it.each([
    'It is the best pack in the range.',
    'This always keeps water out.',
    'According to the manufacturer, the seams are taped.',
    'The Beta is heavier than the Alpha.',
  ])('no longer reads an English word list: %s', (sentence) => {
    expect(checkableKindsIn(sentence)).toEqual([])
  })
})

describe('citations', () => {
  it('fails a figure that appears in none of the claims the sentence cites', () => {
    const capacity = claimIdFor(plan, 'p-alpha', 'capacity')
    const draft = draftWith([{ heading: 'Capacity', body: `The Alpha holds 44 litres[[${capacity}]].` }])
    const result = checkCitations(draft, plan, pack)
    expect(result.issues.map((i) => i.kind)).toContain('number_absent_from_cited_claims')
  })

  it('fails a marker that points at no claim in the plan', () => {
    const draft = draftWith([{ heading: 'Capacity', body: 'The Alpha holds 20 litres[[c999]].' }])
    const result = checkCitations(draft, plan, pack)
    expect(result.issues.map((i) => i.kind)).toContain('unknown_claim_marker')
  })

  it('fails a merchant fact the fact sheet does not actually say', () => {
    const material = claimIdFor(plan, 'p-alpha', 'material')
    const tampered: ClaimPlan = {
      ...plan,
      claims: plan.claims.map((c) => (c.id === material ? { ...c, text: 'The Alpha is made of solid oak.' } : c)),
    }
    const draft = draftWith([{ heading: 'Material', body: `The Alpha is made of solid oak[[${material}]].` }])
    const result = checkCitations(draft, tampered, pack)
    expect(result.issues.map((i) => i.kind)).toContain('merchant_fact_not_in_fact_sheet')
  })

  it('re-derives an arithmetic claim in code rather than trusting it', () => {
    // A comparison the pack's own figures do not produce: the Beta holds more
    // than the Alpha, not less.
    const invented: ClaimPlan = {
      ...plan,
      claims: [
        ...plan.claims,
        {
          id: 'd9',
          text: 'The Alpha has more capacity than The Beta (20l vs 35l).',
          kind: 'derived_fact',
          confidence: 'high',
          evidence: [{ kind: 'claim', claimRef: claimIdFor(plan, 'p-alpha', 'capacity') }],
        },
      ],
    }
    const draft = draftWith([
      { heading: 'Capacity', body: 'The Alpha has more capacity than The Beta (20l vs 35l)[[d9]].' },
    ])
    const result = checkCitations(draft, invented, pack)
    expect(result.issues.map((i) => i.kind)).toContain('derived_claim_not_re_derivable')
  })

  it('accepts the derived claim the pack really does produce', () => {
    const merchantCount = plan.claims.filter((c) => c.kind === 'merchant_fact').length
    expect(merchantCount).toBeGreaterThan(0)
    const result = checkCitations(passingDraft(plan), plan, pack)
    expect(result.issues).toEqual([])
  })

  it('fails an external fact whose quote is not verbatim in the passage it names', () => {
    const withQuote: ClaimPlan = {
      ...plan,
      claims: [
        ...plan.claims,
        {
          id: 'e1',
          text: 'Fit is what most walkers get wrong.',
          kind: 'external_fact',
          confidence: 'medium',
          evidence: [{ kind: 'page', url: 'https://rival.example/packs', quote: 'Fit is what most walkers get wrong' }],
        },
      ],
    }
    const draft = draftWith([{ heading: 'What others say', body: 'Fit is what most walkers get wrong[[e1]].' }])
    const result = checkCitations(draft, withQuote, pack)
    expect(result.issues.map((i) => i.kind)).toContain('external_quote_not_verbatim')
  })
})

describe('assertion strength', () => {
  it('refuses a specific figure resting on a low-confidence claim', () => {
    const weak: ClaimPlan = {
      ...plan,
      claims: [
        ...plan.claims,
        { id: 'w2', text: 'The frame is rated to 30 kg.', kind: 'external_fact', confidence: 'low', evidence: [] },
      ],
    }
    const draft = draftWith([{ heading: 'Frame', body: 'The frame is rated to 30 kg[[w2]].' }])
    const result = checkAssertionStrength(draft, weak)
    expect(result.issues.map((i) => i.kind)).toContain('threshold_on_weak_claim')
  })

  it('allows a flat assertion on a high-confidence merchant fact', () => {
    const capacity = claimIdFor(plan, 'p-alpha', 'capacity')
    const draft = draftWith([{ heading: 'Capacity', body: `The Alpha holds 20 litres[[${capacity}]].` }])
    expect(checkAssertionStrength(draft, plan).passed).toBe(true)
  })
})

describe('structural validity', () => {
  it('catches a ragged table row', () => {
    const draft = draftWith([
      { heading: 'Table', body: '| Pack | Litres |\n| --- | --- |\n| Alpha | 20 | extra |' },
    ])
    expect(checkStructure(draft).issues.map((i) => i.kind)).toContain('ragged_table_row')
  })

  it('catches a duplicate heading', () => {
    const draft = draftWith([{ heading: 'Common mistakes', body: 'Something else entirely.' }])
    expect(checkStructure(draft).issues.map((i) => i.kind)).toContain('duplicate_heading')
  })

  it('catches a skipped heading level', () => {
    const draft = draftWith([{ heading: 'Detail', body: '## A sub-heading\n\ntext\n\n#### Two levels down\n\nmore' }])
    expect(checkStructure(draft).issues.map((i) => i.kind)).toContain('skipped_heading_level')
  })

  it('catches a link with no target', () => {
    const draft = draftWith([{ heading: 'Links', body: 'See [the sizing guide]() for more.' }])
    expect(checkStructure(draft).issues.map((i) => i.kind)).toContain('broken_link')
  })

  it('catches a product placeholder nothing declares', () => {
    const draft = draftWith([{ heading: 'Picks', body: 'The {{p4}} is worth a look.' }])
    expect(checkStructure(draft).issues.map((i) => i.kind)).toContain('unresolvable_product_reference')
  })

  it('catches structured data that does not parse', () => {
    const draft = draftWith([{ heading: 'Data', body: '```json\n{"name": }\n```' }])
    expect(checkStructure(draft).issues.map((i) => i.kind)).toContain('invalid_structured_data')
  })

  it('catches markup that never closes', () => {
    const draft = draftWith([{ heading: 'Emphasis', body: 'This is **important and never closed.' }])
    expect(checkStructure(draft).issues.map((i) => i.kind)).toContain('unclosed_markup')
  })

  it('passes a well-formed draft', () => {
    expect(checkStructure(passingDraft(plan)).passed).toBe(true)
  })
})

describe('contradiction candidates', () => {
  it('flags two thresholds about the same thing that name different figures', () => {
    const draft = draftWith([
      { heading: 'Frames', body: 'Carrying above 300 kg on the trailer calls for the reinforced frame.' },
      { heading: 'Loads', body: 'The reinforced frame is called for above 200 kg on the trailer.' },
    ])
    const candidates = candidateConflicts(extractStatements(draft), config.gates.draft_lints)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.reason).toContain('300')
    expect(candidates[0]!.reason).toContain('200')
  })

  it('does not flag two different products stating their own capacities', () => {
    const draft = draftWith([
      { heading: 'Alpha', body: 'The Alpha holds 20 litres.' },
      { heading: 'Beta', body: 'The Beta holds 35 litres.' },
    ])
    const candidates = candidateConflicts(extractStatements(draft), config.gates.draft_lints)
    expect(candidates).toEqual([])
  })

  it('reads "covers" as an ordinary word, not as "over"', () => {
    const statements = extractStatements(
      draftWith([{ heading: 'Fit', body: 'The lid covers 20 litres of space.' }]),
    )
    const measured = statements.filter((s) => s.unit === 'l')
    expect(measured.every((s) => s.direction === 'exactly')).toBe(true)
  })
})

describe('near-duplicate detection', () => {
  it('measures overlap as a share of the draft’s own phrasing', () => {
    const a = 'the pack holds twenty litres and fits a laptop comfortably in the sleeve'
    expect(similarityAgainst(a, a, 5)).toBe(1)
    expect(similarityAgainst(a, 'entirely different words about something else altogether now', 5)).toBe(0)
  })

  it('fails a draft that repeats one of the store’s own articles', () => {
    const draft = passingDraft(plan)
    const text = [draft.intro, ...draft.sections.map((s) => s.body)].join('\n')
    const result = checkNearDuplicate(
      text,
      [{ label: 'Choosing a daysack', kind: 'own_article', text }],
      config.gates.draft_lints,
    )
    expect(result.passed).toBe(false)
    expect(result.issues[0]!.location).toContain('your other articles')
  })
})

describe('keyword stuffing', () => {
  it('counts the target phrase, not its separate words', () => {
    const text = 'hiking backpacks are good. ' + 'filler words here and there. '.repeat(10)
    expect(keywordDensity(text, 'hiking backpacks')).toBeGreaterThan(0)
    expect(keywordDensity(text, 'hiking backpacks')).toBeLessThan(config.gates.draft_lints.keyword_density_max + 0.05)
  })

  it('rises above the ceiling when the phrase is repeated into the prose', () => {
    const text = 'hiking backpacks '.repeat(5) + 'and a few other words to pad this out a little bit more.'
    expect(keywordDensity(text, 'hiking backpacks')).toBeGreaterThan(config.gates.draft_lints.keyword_density_max)
  })
})
