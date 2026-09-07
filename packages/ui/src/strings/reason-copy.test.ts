import { describe, expect, it } from 'vitest'
import { driftPolicies } from '@sortiva/core'
import { renderTemplatedLine } from '../opportunities/why'
import { t } from './index'
import {
  ADMISSION_REASON_PARAMS,
  GATE_REASON_KEYS,
  GATE_REASON_PARAMS,
  OPPORTUNITY_REASON_KEYS,
  REASON_KEYS_AWAITING_COPY,
  SCAN_REASON_PARAMS,
  signalNamesWithoutCopy,
  signalNamesNothingBuilds,
  REPAIR_REASON_PARAMS,
  placeholdersIn,
  reasonKeysWithoutCopy,
  repairReasonKeys,
} from './reason-copy'

/**
 * The renderer is deliberately forgiving: a key it has no sentence for shows an
 * admission rather than a crash or a raw key, because a merchant should never
 * pay for a copywriter's oversight. The price of that forgiveness is that a
 * missing sentence looks exactly like a working screen, which is how the repair
 * path shipped with no explanations at all.
 *
 * These tests are where that stops being free.
 */

describe('the explanations a drifted article can be given', () => {
  it('exist for every kind of drift, by name', () => {
    const missing = reasonKeysWithoutCopy(repairReasonKeys())
    expect(missing, `no sentence in packages/ui/strings/en.json for: ${missing.join(', ')}`).toEqual(
      [],
    )
  })

  it('reach the merchant as words rather than as the renderer giving up', () => {
    for (const key of repairReasonKeys()) {
      const line = renderTemplatedLine({ templateKey: key, params: {} })
      expect(line.known, `${key} fell through to the "no reasoning yet" line`).toBe(true)
      expect(line.text).not.toBe(t('opportunities.whyUnavailable'))
      expect(line.text.trim().length).toBeGreaterThan(0)
    }
  })

  it('ask only for the numbers the repair path actually sends', () => {
    for (const key of repairReasonKeys()) {
      for (const placeholder of placeholdersIn(key)) {
        expect(
          REPAIR_REASON_PARAMS,
          `"${key}" asks for {${placeholder}}, which no drift observation supplies — it would print literally`,
        ).toContain(placeholder)
      }
    }
  })

  it('covers the whole drift policy table, so a new kind of drift cannot arrive wordless', () => {
    expect(driftPolicies().map((policy) => policy.kind)).toEqual([
      'product_deleted',
      'product_out_of_stock',
      'family_axes_changed',
      'collection_deleted',
    ])
    expect(repairReasonKeys()).toHaveLength(driftPolicies().length)
  })
})

describe('the rest of the reason vocabulary', () => {
  it('has a sentence for everything except the gaps we have written down', () => {
    const missing = reasonKeysWithoutCopy(OPPORTUNITY_REASON_KEYS)
    const unrecorded = missing.filter((key) => !REASON_KEYS_AWAITING_COPY.includes(key))
    expect(
      unrecorded,
      `these reasons would render blank and are not on the known-gap list: ${unrecorded.join(', ')}`,
    ).toEqual([])
  })

  it('keeps the gap list honest — a reason that has been written stops being a gap', () => {
    const written = REASON_KEYS_AWAITING_COPY.filter((key) => !reasonKeysWithoutCopy([key]).length)
    expect(
      written,
      `these now have copy and should be removed from REASON_KEYS_AWAITING_COPY: ${written.join(', ')}`,
    ).toEqual([])
  })
})

describe('what a merchant sees a signal called', () => {
  it('has a name for every signal that can put a card on screen', () => {
    const missing = signalNamesWithoutCopy()
    expect(
      missing,
      `these render a machine-generated name instead — "missing_or_weak_metadata" came out as "Missing Or Weak Metadata": ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('holds no name under a key the engine never builds', () => {
    // The half that hid the fault: `missing_metadata` and `wrong_canonical`
    // held good copy no card could reach, because the engine builds
    // `missing_or_weak_metadata` and `wrong_canonical_or_duplicate`.
    expect(
      signalNamesNothingBuilds().filter((type) =>
        ['missing_metadata', 'wrong_canonical'].includes(type),
      ),
    ).toEqual([])
  })
})

describe('the scan reasons, now that they have words', () => {
  it('reach the merchant as words rather than as the renderer giving up', () => {
    for (const key of OPPORTUNITY_REASON_KEYS) {
      const line = renderTemplatedLine({ templateKey: key, params: {} })
      expect(line.known, `${key} fell through to the "no reasoning yet" line`).toBe(true)
      expect(line.text.trim().length).toBeGreaterThan(0)
    }
  })

  it('ask only for numbers the scan actually sends', () => {
    for (const [key, params] of Object.entries(SCAN_REASON_PARAMS)) {
      for (const placeholder of placeholdersIn(key)) {
        expect(
          params,
          `"${key}" asks for {${placeholder}}, which the scan does not supply — it would print literally`,
        ).toContain(placeholder)
      }
    }
  })
})

/**
 * The same comparison, pointed at the quality gates for the first time.
 *
 * These sentences were written and then never seen. The engine files a
 * rejection under `gate3.below_quality_bar`; the lookup asked the catalogue for
 * `template.gate3.below_quality_bar`; the catalogue held the first. So every
 * merchant whose article was stopped by the quality bar read "the reasoning for
 * this one isn't available yet" while eleven finished sentences sat unused.
 * Nothing failed, because nothing compared the two sides.
 */
describe('the quality gate reasons', () => {
  it('reach the merchant as words rather than as the renderer giving up', () => {
    for (const key of Object.keys(GATE_REASON_PARAMS)) {
      const line = renderTemplatedLine({ templateKey: key, params: {} })
      expect(line.known, `${key} fell through to the "no reasoning yet" line`).toBe(true)
      expect(line.text).not.toBe(t('opportunities.whyUnavailable'))
      expect(line.text.trim().length).toBeGreaterThan(0)
    }
  })

  it('ask only for the values the gate actually sends', () => {
    for (const [key, params] of Object.entries(GATE_REASON_PARAMS)) {
      for (const placeholder of placeholdersIn(key)) {
        expect(
          params,
          `"${key}" asks for {${placeholder}}, which Gate 3 does not supply — it would print literally`,
        ).toContain(placeholder)
      }
    }
  })

  it('has a sentence for every gate and calendar key except the gaps we have written down', () => {
    const missing = reasonKeysWithoutCopy(GATE_REASON_KEYS)
    const unrecorded = missing.filter((key) => !REASON_KEYS_AWAITING_COPY.includes(key))
    expect(
      unrecorded,
      `these would render "the reasoning for this one isn't available yet" and are not on the known-gap list: ${unrecorded.join(', ')}`,
    ).toEqual([])
  })

  it('covers every gate-3 outcome, so a new one cannot arrive wordless', () => {
    // Mirrors `LintCategory` plus the grader's own three branches. A category
    // added to the gate and not to this list is the fault that shipped: the
    // engine files a reason nothing in the catalogue answers.
    expect(Object.keys(GATE_REASON_PARAMS)).toEqual([
      'gate3.structure',
      'gate3.citations',
      'gate3.assertion_strength',
      'gate3.volatile_values',
      'gate3.length',
      'gate3.internal_links',
      'gate3.keyword_stuffing',
      'gate3.near_duplicate',
      'gate3.contradiction',
      'gate3.no_information_gain',
      'gate3.below_quality_bar',
    ])
  })
})

/**
 * The topic-admission reasons: Gate 1, Gate 2, and why a day holds the topic it
 * holds.
 *
 * These eleven were produced by the product and answered by nothing. The
 * loudest was `topic.auto`, which is the why-line on **every** chip in the
 * content calendar, so a merchant looking at their plan read "The reasoning for
 * this one isn't available yet." against every planned day.
 *
 * The tests below are stricter than their siblings in one way, and deliberately
 * so: these sentences must survive being rendered with **no** parameters,
 * because that is what the calendar sends. See `ADMISSION_REASON_PARAMS`.
 */
describe('the topic admission reasons', () => {
  it('reach the merchant as words rather than as the renderer giving up', () => {
    for (const key of Object.keys(ADMISSION_REASON_PARAMS)) {
      const line = renderTemplatedLine({ templateKey: key, params: {} })
      expect(line.known, `${key} fell through to the "no reasoning yet" line`).toBe(true)
      expect(line.text).not.toBe(t('opportunities.whyUnavailable'))
      expect(line.text.trim().length).toBeGreaterThan(0)
    }
  })

  it('survive a held day, whose second sentence still gets no values', () => {
    // Not a stylistic rule. Gate 1 stores its measurements under a shape the
    // read-back does not look at, and Gate 2 stores none — so a blank in one of
    // these sentences reaches a merchant as the literal text `{keyword}`. The
    // calendar's routes now do send their values, but a held day renders two
    // sentences — why the day was planned, and why it was stopped — and only
    // the first comes from the calendar. This is what stops a well-meant edit
    // adding a blank to the second before the values arrive.
    const leaking: string[] = []
    for (const key of Object.keys(ADMISSION_REASON_PARAMS)) {
      const placeholders = placeholdersIn(key)
      if (placeholders.length > 0) leaking.push(`${key} asks for {${placeholders.join('}, {')}}`)
    }
    expect(
      leaking,
      'these would print a raw placeholder on a calendar chip, which sends no values at all',
    ).toEqual([])
  })

  it('ask only for values one of the two gates actually measures', () => {
    for (const [key, params] of Object.entries(ADMISSION_REASON_PARAMS)) {
      for (const placeholder of placeholdersIn(key)) {
        expect(
          params,
          `"${key}" asks for {${placeholder}}, which its producer does not supply — it would print literally`,
        ).toContain(placeholder)
      }
    }
  })

  it('covers every Gate 1 outcome and both calendar why-lines, so a new one cannot arrive wordless', () => {
    // Mirrors the keys `runGate1` and `runGate2` build, plus the two the
    // calendar routes fall back to. An outcome added to a gate and not to this
    // list is the fault this file exists to catch.
    expect(Object.keys(ADMISSION_REASON_PARAMS)).toEqual([
      'gate1.admitted',
      'gate1.admitted_pinned_despite_zero_volume',
      'gate1.rejected_zero_volume',
      'gate1.rejected_not_winnable',
      'gate1.rejected_off_catalog',
      'gate1.converted_existing_target_optimize',
      'gate1.converted_existing_target_refresh',
      'gate1.held_insufficient_substance',
      'gate2.held_thin_pack',
      'topic.auto',
      'topic.manual_addition',
    ])
  })

  it('uses the canonical wording where the spec already approved one', () => {
    // Two of these say exactly what a pinned Appendix A string says, so they
    // point at it rather than paraphrasing it on a second screen.
    expect(renderTemplatedLine({ templateKey: 'gate1.held_insufficient_substance', params: {} }).text).toBe(
      t('appendixA.qualityRejectionRichness'),
    )
    expect(
      renderTemplatedLine({ templateKey: 'gate1.converted_existing_target_optimize', params: {} }).text,
    ).toBe(t('appendixA.existingPageWhyLine'))
  })
})

/**
 * The forgiving path itself, which is what made all of the above invisible.
 *
 * It is the right behaviour to keep — a merchant should never be shown a raw
 * key or a blank space — so these pin what it does rather than arguing with it.
 * The loudness belongs in the tests above, which is where a key mismatch now
 * has to be answered.
 */
describe('a key the catalogue has no sentence for', () => {
  it('says so plainly, and reports itself as unknown', () => {
    const line = renderTemplatedLine({ templateKey: 'gate3.a_reason_nobody_has_written', params: {} })
    expect(line.known).toBe(false)
    expect(line.text).toBe(t('opportunities.whyUnavailable'))
  })

  it('does the same for a missing reason altogether', () => {
    expect(renderTemplatedLine(null).known).toBe(false)
    expect(renderTemplatedLine(null).text).toBe(t('opportunities.whyUnavailable'))
  })
})
