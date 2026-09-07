import { describe, expect, it } from 'vitest'
import {
  REPLENISHMENT_WHY_COMPETITOR,
  REPLENISHMENT_WHY_EXPLORATION,
  REPLENISHMENT_WHY_REFRESH_POSITION,
  REPLENISHMENT_WHY_WINNING_PATTERN,
  topicWhyLine,
  type TopicWhyOpportunity,
} from '@sortiva/core'
import { renderTemplatedLine, t } from '@sortiva/ui'
import {
  ADMISSION_REASON_PARAMS,
  GATE_REASON_PARAMS,
  OPPORTUNITY_REASON_KEYS,
  REPAIR_REASON_PARAMS,
  SCAN_REASON_PARAMS,
  repairReasonKeys,
} from '@sortiva/ui/strings/reason-copy'

/**
 * What a merchant actually reads under a day on the content calendar.
 *
 * Every check here renders the sentence and looks at the words. That is the
 * whole point of the file: for months the calendar's own tests asserted on the
 * *shape* of the response — a `templateKey` and a `params` object were present,
 * so it looked right — while the sentence those two produced on screen read
 * "There is steady demand here — around {volume} searches a month" with the
 * braces showing. Nothing that reads a template rather than its output can see
 * that, which is why nothing did.
 *
 * A brace surviving into the text is the failure. `{` appears in no sentence in
 * the catalogue for any other reason.
 */

/**
 * The values each producer says it sends, taken from the producer's own side
 * rather than from the sentences — the point is to prove the sentences can be
 * filled by what actually arrives, so reading the sentence to decide what to
 * send it would prove nothing.
 */
function producerParams(key: string): Readonly<Record<string, string | number>> {
  const names =
    SCAN_REASON_PARAMS[key] ??
    ADMISSION_REASON_PARAMS[key] ??
    REQUEST_REFRESH_REASON_PARAMS[key] ??
    (repairReasonKeys().includes(key) ? REPAIR_REASON_PARAMS : []) ??
    []
  return Object.fromEntries(names.map((name) => [name, 1]))
}

/**
 * The two reasons a rewrite of our own article carries, which the shared table
 * of "what each producer sends" in `packages/ui` does not list — it covers the
 * weekly scan, the gates and the repair sweep, and these come from a fourth
 * producer (`requestRefresh`, which names the article it was asked to rewrite).
 * Written out here so this file checks them; the gap in the shared table is
 * reported separately rather than widened from another lane.
 */
const REQUEST_REFRESH_REASON_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'freshness_opportunity.requested': ['article_title'],
  'freshness_opportunity.our_own_article': ['article_title'],
}

const opportunityWith = (over: Partial<TopicWhyOpportunity>): TopicWhyOpportunity => ({
  reasonTemplateKey: 'uncovered_commercial_query.create',
  reasonParams: producerParams('uncovered_commercial_query.create'),
  evidence: [],
  ...over,
})

/** The sentence as it reaches the screen, from the key a day stored and the row behind it. */
const chip = (whyLineKey: string | null, opportunity: TopicWhyOpportunity | null, fallbackKey = 'topic.auto') =>
  renderTemplatedLine(topicWhyLine({ whyLineKey, fallbackKey, opportunity }), t)

/**
 * Every key `topics.why_line` can hold. Three producers write it and nothing
 * else does: the scheduler stores the opportunity's own reason key, the
 * replenishment planner stores one of its four, and adding a topic by hand
 * stores Gate 1's verdict. The two `topic.` lines are what a screen falls back
 * to when the column is empty.
 */
const REPLENISHMENT_WHY_KEYS = [
  REPLENISHMENT_WHY_EXPLORATION,
  REPLENISHMENT_WHY_WINNING_PATTERN,
  REPLENISHMENT_WHY_REFRESH_POSITION,
  REPLENISHMENT_WHY_COMPETITOR,
] as const

const CALENDAR_OWN_KEYS = ['topic.auto', 'topic.manual_addition'] as const

const GATE_1_WHY_KEYS = Object.keys(ADMISSION_REASON_PARAMS).filter((key) => key.startsWith('gate1.'))

describe('the sentence under a calendar day, as a merchant reads it', () => {
  it('bites: a planned day names the demand behind it instead of printing {volume}', () => {
    // The exact sentence and the exact defect this card exists for.
    const line = chip('uncovered_commercial_query.create', opportunityWith({ reasonParams: { volume: 1900 } }))
    expect(line.known).toBe(true)
    expect(line.text).toContain('1900')
    expect(line.text).not.toContain('{')
  })

  it('bites: a replenishment day names the position instead of printing {position}', () => {
    const line = chip(
      REPLENISHMENT_WHY_REFRESH_POSITION,
      opportunityWith({
        reasonTemplateKey: 'striking_distance.refresh_ours',
        reasonParams: producerParams('striking_distance.refresh_ours'),
        evidence: [{ key: 'mean_position', value: 14 }],
      }),
    )
    expect(line.text).toContain('14')
    expect(line.text).not.toContain('{')
  })

  it('renders every reason an opportunity can put on a day with no blank left in it', () => {
    const leaking: string[] = []
    for (const key of OPPORTUNITY_REASON_KEYS) {
      const line = chip(key, opportunityWith({ reasonTemplateKey: key, reasonParams: producerParams(key) }))
      if (!line.known) leaking.push(`${key} has no sentence at all`)
      else if (line.text.includes('{')) leaking.push(`${key} rendered as "${line.text}"`)
    }
    expect(leaking, 'these would print a raw placeholder under a calendar day').toEqual([])
  })

  it('renders every Gate 1 verdict a hand-added day can carry with no blank left in it', () => {
    // A topic the merchant typed in gets an opportunity row of its own carrying
    // Gate 1's verdict as its reason — key and measurements together — so
    // whatever those sentences come to say, the values are there to say it with.
    const leaking: string[] = []
    for (const key of GATE_1_WHY_KEYS) {
      const line = chip(
        key,
        opportunityWith({ reasonTemplateKey: key, reasonParams: producerParams(key) }),
        'topic.manual_addition',
      )
      if (!line.known) leaking.push(`${key} has no sentence at all`)
      else if (line.text.includes('{')) leaking.push(`${key} rendered as "${line.text}"`)
    }
    expect(leaking).toEqual([])
  })

  it('renders each of the planner’s own four lines with no blank left in it', () => {
    const withPosition = opportunityWith({ evidence: [{ key: 'our_position', value: 9 }] })
    const withoutPosition = opportunityWith({})
    for (const key of REPLENISHMENT_WHY_KEYS) {
      for (const opportunity of [withPosition, withoutPosition]) {
        const line = chip(key, opportunity)
        expect(line.known, `${key} has no sentence`).toBe(true)
        expect(line.text, `${key} left a blank in "${line.text}"`).not.toContain('{')
      }
    }
  })

  it('renders the two lines the calendar writes itself, and an empty column, with no blank', () => {
    for (const key of [...CALENDAR_OWN_KEYS, null]) {
      const line = chip(key, opportunityWith({}))
      expect(line.known).toBe(true)
      expect(line.text).not.toContain('{')
    }
  })

  it('bites: a key nobody has written words for never reaches a merchant as a raw key or a blank', () => {
    // Two shapes of this. With the opportunity in hand the day explains itself
    // with the reason that row carries, which is stored as a key and its values
    // together and so is always fillable. With nothing to read — a row gone
    // from under the day, which the foreign key should make impossible — it
    // falls to the calendar's own line rather than to an unfillable sentence.
    const withRow = chip('a_signal.nobody_has_worded', opportunityWith({}))
    expect(withRow.known).toBe(true)
    expect(withRow.text).not.toContain('{')
    expect(withRow.text).not.toContain('a_signal')

    const withoutRow = chip('a_signal.nobody_has_worded', null)
    expect(withoutRow.text).toBe(t('topic.auto'))
    expect(withoutRow.text).not.toContain('{')
  })

  /**
   * The second sentence a held day shows: not why it was planned, but why it
   * was stopped. It is filled from the gate's own decision row rather than from
   * the opportunity, so it is a separate path with a separate failure — and the
   * two gates that stop a topic before it is written record their measurements
   * where the read-back does not look, so they supply nothing at all today.
   */
  describe('the sentence on a day a gate held back', () => {
    it('renders with what the quality gate recorded, and no blank', () => {
      const leaking: string[] = []
      for (const [key, names] of Object.entries(GATE_REASON_PARAMS)) {
        const params = Object.fromEntries(names.map((name) => [name, 1]))
        const line = renderTemplatedLine({ templateKey: key, params }, t)
        if (!line.known) leaking.push(`${key} has no sentence at all`)
        else if (line.text.includes('{')) leaking.push(`${key} rendered as "${line.text}"`)
      }
      expect(leaking).toEqual([])
    })

    it('renders with what the two admission gates recorded, and no blank', () => {
      // All three gates now record their measurements where the read-back
      // looks, so this sentence is filled from the gate's own decision row
      // whichever gate wrote it. That the values genuinely make that journey —
      // gate, to database, to the calendar's response — is proved against a
      // real database in `gate-reason-params.test.ts`; this checks the sentence
      // each set of values has to fill.
      const leaking: string[] = []
      for (const [key, names] of Object.entries(ADMISSION_REASON_PARAMS)) {
        const params = Object.fromEntries(names.map((name) => [name, 1]))
        const line = renderTemplatedLine({ templateKey: key, params }, t)
        if (!line.known) leaking.push(`${key} has no sentence at all`)
        else if (line.text.includes('{')) leaking.push(`${key} rendered as "${line.text}"`)
      }
      expect(leaking).toEqual([])
    })

    it('bites: the two lines the calendar writes itself carry no blank, having nothing to fill one with', () => {
      // These two are the calendar's own words about the calendar. Nothing
      // measures a value for either, so a blank in one would print raw on every
      // chip — which is what `topic.auto` did for the life of the feature.
      for (const key of ['topic.auto', 'topic.manual_addition']) {
        const line = renderTemplatedLine({ templateKey: key, params: {} }, t)
        expect(line.known).toBe(true)
        expect(line.text, `${key} rendered as "${line.text}"`).not.toContain('{')
      }
    })
  })
})
