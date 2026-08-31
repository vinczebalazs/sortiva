import { describe, expect, it } from 'vitest'
import { rules } from '@sortiva/rules'
import { countSubstance, generateSyntheticStore } from './syntheticStore'
import { scenario, signalScenarios } from './scenarios'

/**
 * `signals.fixtures` — the fixed suite name CLAUDE.md reserves for main §7.8's
 * eight acceptance fixtures. Lane C's signal-detection card extends this file
 * with the detection assertions; T0.6 proves the fixtures themselves are
 * deterministic and actually carry the evidence each scenario claims.
 */

describe('synthetic store generator', () => {
  it('produces identical data for the same seed', () => {
    expect(generateSyntheticStore({ seed: 42 })).toEqual(generateSyntheticStore({ seed: 42 }))
  })

  it('produces different data for a different seed', () => {
    expect(generateSyntheticStore({ seed: 42 })).not.toEqual(generateSyntheticStore({ seed: 43 }))
  })

  it('mixes spec-heavy and fluff products, so both §6.3 paths have inputs', () => {
    const store = generateSyntheticStore({ seed: 7 })
    const styles = new Set(store.products.map((p) => p.style))
    expect(styles).toEqual(new Set(['spec', 'fluff']))
  })

  it('records the differentiation axes each family is grouped on (main §6.4)', () => {
    const store = generateSyntheticStore({ seed: 7 })
    const trail = store.families.find((f) => f.key === 'trail-running')
    expect(trail?.axes).toEqual(['terrain', 'drop', 'width'])
    expect(trail?.memberIds.length).toBeGreaterThan(0)
  })
})

describe('§7.8 acceptance fixtures', () => {
  const scenarios = signalScenarios()

  it('covers all eight worked examples exactly once', () => {
    expect(scenarios.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('generates deterministic data for every scenario', () => {
    expect(signalScenarios()).toEqual(scenarios)
  })

  it('scenario 1 carries the spec’s own numbers: position 7.3, 9,402 impressions / 28d', () => {
    const s = scenario(1)
    const rows = s.gsc.filter((r) => r.query === 'best trail running shoes')
    expect(rows).toHaveLength(28)
    expect(rows.reduce((n, r) => n + r.impressions, 0)).toBe(9402)
    expect(new Set(rows.map((r) => r.position))).toEqual(new Set([7.3]))
  })

  it('scenario 2 carries 15,000 impressions and 310 clicks at position 3.4', () => {
    const rows = scenario(2).gsc
    expect(rows.reduce((n, r) => n + r.impressions, 0)).toBe(15000)
    expect(rows.reduce((n, r) => n + r.clicks, 0)).toBe(310)
  })

  it('scenario 3 has no URL that could serve the query — the absence is the evidence', () => {
    const s = scenario(3)
    expect(s.hasSuitableUrl).toBe(false)
    expect(s.gsc).toHaveLength(0)
    expect(s.store.pages.some((p) => p.includes('trail'))).toBe(false)
  })

  it('scenario 5 has three of our own URLs competing for one query', () => {
    const queries = new Set(scenario(5).gsc.map((r) => r.query))
    const pages = new Set(scenario(5).gsc.map((r) => r.page))
    expect(queries.size).toBe(1)
    expect(pages.size).toBe(3)
  })

  it('scenario 6 supplies both windows: 3.8 → 7.1, 1,700 → 860 clicks', () => {
    const rows = scenario(6).gsc
    const byPosition = new Map<number, number>()
    for (const row of rows) {
      byPosition.set(row.position, (byPosition.get(row.position) ?? 0) + row.clicks)
    }
    expect(byPosition.get(3.8)).toBe(1700)
    expect(byPosition.get(7.1)).toBe(860)
  })

  it('scenario 7 genuinely fails the substance floor it exists to trigger', () => {
    const gates = rules().defaults.gates.substance_floor
    const { distinctFacts, contributingProducts } = countSubstance(
      scenario(7).store.products,
      gates.populated_fields_per_product_min,
    )
    // This is the assertion that keeps the fixture honest: if the generator
    // ever starts producing substance here, "HOLD" would be the wrong answer
    // and the scenario would silently stop testing anything.
    expect(
      distinctFacts < gates.distinct_facts_min ||
        contributingProducts < gates.contributing_products_min,
    ).toBe(true)
  })

  it('scenario 8 shows a page with no impressions at all', () => {
    expect(scenario(8).gsc.every((r) => r.impressions === 0)).toBe(true)
  })

  it('rejects an out-of-range scenario id rather than returning undefined', () => {
    expect(() => scenario(9)).toThrow(/defines 1–8/)
  })
})
