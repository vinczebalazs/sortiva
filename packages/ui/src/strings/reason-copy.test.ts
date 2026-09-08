import { describe, expect, it } from 'vitest'
import {
  buildConsolidationRecommendation,
  driftPolicies,
  renderConsolidationView,
  OPTIMIZE_FAILED_VALIDATION_KEY,
} from '@sortiva/core'
import { renderTemplatedLine } from '../opportunities/why'
import { t } from './index'
import {
  ADMISSION_REASON_PARAMS,
  COUNTS_PHRASED_AROUND,
  GATE_REASON_KEYS,
  GATE_REASON_PARAMS,
  OPPORTUNITY_REASON_KEYS,
  REASON_KEYS_AWAITING_COPY,
  SCAN_REASON_PARAMS,
  signalNamesWithoutCopy,
  signalNamesNothingBuilds,
  REPAIR_REASON_PARAMS,
  UNRECORDED_REASON_PARAMS,
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
 * The other direction: numbers the scan measures and sends, and no sentence
 * ever shows a merchant.
 *
 * This was a written list with nothing checking it, and it went stale — it
 * still said nine numbers were being avoided for want of singular and plural
 * forms months after the renderer had them. A list that describes the copy is
 * only true on the day it is written; this makes the copy answer for it.
 */
describe('the numbers the scan sends and no sentence prints', () => {
  const sent = new Set(Object.values(SCAN_REASON_PARAMS).flat())
  const printed = new Set(Object.keys(SCAN_REASON_PARAMS).flatMap((key) => placeholdersIn(key)))

  it('has both sides of the comparison in hand', () => {
    // An empty set on either side would make the equality below pass over
    // nothing at all, which is how the list it replaces came to be wrong.
    expect(sent.size).toBeGreaterThan(10)
    expect(printed.size).toBeGreaterThan(5)
  })

  it('is exactly the list that says so, with a reason written beside each', () => {
    const unprinted = [...sent].filter((name) => !printed.has(name))
    expect(
      unprinted.sort(),
      'either a sentence started printing one of these and the note beside it is now wrong, ' +
        'or a number stopped being printed and nobody said why',
    ).toEqual([...COUNTS_PHRASED_AROUND].sort())
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
 * These sentences carried no numbers at all until now, because none of their
 * values reached a screen. They do now — the calendar's routes send a day's own
 * explanation, and both gates record their measurements where the read-back
 * looks — so the only sentences here still barred from a blank are the two the
 * calendar composes itself, which have no measurement behind them.
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

  it('stay free of blanks where the calendar composes the sentence itself', () => {
    // These two are the calendar's own words about the calendar — that a day
    // was planned from the merchant's opportunities, or typed in by hand — and
    // there is no measurement behind either, so nothing could ever fill a blank
    // in them. Every other sentence here may now carry one: the values reach
    // the screen, proved by rendering in
    // `apps/web/app/api/calendar/_lib/gate-reason-params.test.ts`.
    const leaking: string[] = []
    for (const key of ['topic.auto', 'topic.manual_addition']) {
      const placeholders = placeholdersIn(key)
      if (placeholders.length > 0) leaking.push(`${key} asks for {${placeholders.join('}, {')}}`)
    }
    expect(leaking, 'nothing measures a value for these, so a blank would print raw').toEqual([])
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
 * The admission a held day carries when the row that stopped it recorded no
 * reason of its own.
 *
 * This key reached a merchant's screen before it reached this file, and looked
 * like a working screen while it did — the renderer's own "not available yet"
 * line is indistinguishable from a sentence somebody wrote. That is the fault
 * this file exists to catch, so the key is listed here and its sentence is held
 * to the same standard as every other.
 */
describe('the reason we did not record', () => {
  it('reaches the merchant as words rather than as the renderer giving up', () => {
    const line = renderTemplatedLine({ templateKey: 'gate.reason_unrecorded', params: {} })
    expect(line.known, 'gate.reason_unrecorded fell through to the "no reasoning yet" line').toBe(
      true,
    )
    expect(line.text).not.toBe(t('opportunities.whyUnavailable'))
    expect(line.text.trim().length).toBeGreaterThan(0)
  })

  it('never says what a gate would have said', () => {
    // The sentence it replaced: borrowing it told a merchant their product
    // descriptions were too thin, under a heading naming a check that never
    // looked at them.
    const line = renderTemplatedLine({ templateKey: 'gate.reason_unrecorded', params: {} })
    expect(line.text).not.toBe(t('appendixA.qualityRejectionRichness'))
  })

  it('has no blanks, because the calendar sends it nothing to fill them with', () => {
    // The route passes an empty bag on purpose — what the row did measure
    // belongs to the sentence that was never written. A blank here would print
    // to a merchant as `{keyword}`.
    expect(placeholdersIn('gate.reason_unrecorded')).toEqual([])
    expect(UNRECORDED_REASON_PARAMS['gate.reason_unrecorded']).toEqual([])
  })

  it('is counted among the keys the product produces', () => {
    expect(GATE_REASON_KEYS).toContain('gate.reason_unrecorded')
    expect(Object.keys(UNRECORDED_REASON_PARAMS)).toEqual(['gate.reason_unrecorded'])
  })
})

/**
 * Explanations whose sentences were written straight into the catalogue under
 * their finished names, rather than as `template.<something>`.
 *
 * Every one of these had a sentence sitting in the catalogue, spelled exactly
 * as the code that produces it spells it, and every one of them reached a
 * merchant as "the reasoning for this one isn't available yet" — because the
 * lookup only ever tried the `template.` shelf. Nothing crashed and nothing
 * looked broken, which is why it survived four separate arrivals of the same
 * mistake.
 *
 * These tests ask the question from the merchant's side: for each key the
 * product really produces, do words come back?
 */
describe('a sentence written under its own name rather than under `template.`', () => {
  it('reaches a merchant whose page recommendation failed our own safety checks', () => {
    // The key is imported from the code that writes it, so renaming it on
    // either side fails here rather than going quiet on the drawer.
    const line = renderTemplatedLine({ templateKey: OPTIMIZE_FAILED_VALIDATION_KEY, params: {} })
    expect(line.known, `${OPTIMIZE_FAILED_VALIDATION_KEY} fell through to the "no reasoning yet" line`).toBe(
      true,
    )
    expect(line.text).not.toBe(t('opportunities.whyUnavailable'))
    expect(line.text).toBe(t('optimize.failedValidation.reason'))
  })

  it('reaches a merchant whose typed-in topic we could not classify, word for word', () => {
    // Produced by the manual-topic path when the classifier is unavailable
    // (`packages/jobs/src/generation/add-manual-topic.ts`), and handed to the
    // add-topic form as the refusal. It is one of the sentences the product may
    // not reword, so the wording is asserted here and not paraphrased.
    const line = renderTemplatedLine({ templateKey: 'appendixA.outage', params: {} })
    expect(line.known, 'appendixA.outage fell through to the "no reasoning yet" line').toBe(true)
    expect(line.text).toBe(
      'Delayed — we paused this action rather than continue with lower-quality or stale data.',
    )
  })

  it('reaches a merchant reading which of their competing pages should win', () => {
    // Built by the real producer rather than by listing its keys here, so a
    // line added to the consolidation advice is covered the day it is written.
    const view = renderConsolidationView(
      buildConsolidationRecommendation({
        clusterHead: 'trail running shoes',
        competing: [
          { url: '/collections/a', pageType: 'collection', impressionShare: 0.6, position: 8 },
          { url: '/products/b', pageType: 'product', impressionShare: 0.4, position: 11 },
        ],
        inventory: [{ url: '/pages/x', outboundInternalLinks: ['/products/b'] }],
      }),
    )
    const lines = view.sections.flatMap((section) => section.lines)
    expect(lines.length).toBeGreaterThan(3)
    for (const line of lines) {
      const rendered = renderTemplatedLine(line)
      expect(rendered.known, `${line.templateKey} fell through to the "no reasoning yet" line`).toBe(
        true,
      )
      expect(rendered.text).not.toBe(t('opportunities.whyUnavailable'))
      expect(rendered.text).not.toContain('{')
    }
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
