import { describe, expect, it } from 'vitest'
import { driftPolicies } from '@sortiva/core'
import { renderTemplatedLine } from '../opportunities/why'
import { t } from './index'
import {
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
