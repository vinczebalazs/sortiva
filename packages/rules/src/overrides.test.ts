import { describe, expect, it } from 'vitest'
import { loadRulesConfig, versionCarriesOverrides } from './load'
import { RulesOverrideError, type RulesOverrideRow } from './overrides'

/**
 * `rules_overrides` is the layer above the repo file: one store, one language,
 * one page type. The two things worth proving are that the narrowest row wins,
 * and that a decision made under an override cannot be mistaken for one made on
 * the defaults — the second is what keeps `rules_version` an honest record.
 */

const config = loadRulesConfig()
const STORE = '11111111-1111-1111-1111-111111111111'
const DEMAND_FLOOR = 'gates.demand_floor.monthly_search_volume_min'

function row(partial: Partial<RulesOverrideRow> & Pick<RulesOverrideRow, 'key' | 'value'>): RulesOverrideRow {
  return {
    scope: {},
    updatedBy: 'operator@example.com',
    updatedAt: new Date('2026-09-07T00:00:00.000Z'),
    ...partial,
  }
}

const defaultFloor = config.defaults.gates.demand_floor.monthly_search_volume_min

describe('folding rules_overrides onto a layer', () => {
  it('leaves a store with no rows exactly where it was', () => {
    const resolved = config.resolve({ locale: 'en-US' })
    expect(resolved.layer).toBe(config.forLocale('en-US'))
    expect(resolved.rulesVersion).toBe(config.rulesVersion)
    expect(resolved.appliedOverrides).toEqual([])
  })

  it('changes the threshold for the store the row names', () => {
    const resolved = config.resolve({
      accountId: STORE,
      locale: 'en-US',
      overrides: [row({ scope: { accountId: STORE }, key: DEMAND_FLOOR, value: defaultFloor + 1 })],
    })
    expect(resolved.layer.gates.demand_floor.monthly_search_volume_min).toBe(defaultFloor + 1)
    // Another store asking the same question is untouched, because nothing was
    // written back into the shared config object.
    expect(config.forLocale('en-US').gates.demand_floor.monthly_search_volume_min).toBe(defaultFloor)
    expect(config.defaults.gates.demand_floor.monthly_search_volume_min).toBe(defaultFloor)
  })

  it('inherits every number the row does not name', () => {
    const resolved = config.resolve({
      accountId: STORE,
      overrides: [row({ scope: { accountId: STORE }, key: DEMAND_FLOOR, value: 1 })],
    })
    expect(resolved.layer.learning.refresh.cooldown_days).toBe(config.defaults.learning.refresh.cooldown_days)
  })

  it('lets the row for one store beat the row for its language', () => {
    const resolved = config.resolve({
      accountId: STORE,
      locale: 'en',
      overrides: [
        row({ scope: { accountId: STORE }, key: DEMAND_FLOOR, value: 7 }),
        row({ scope: { locale: 'en' }, key: DEMAND_FLOOR, value: 500 }),
      ],
    })
    expect(resolved.layer.gates.demand_floor.monthly_search_volume_min).toBe(7)
    expect(resolved.appliedOverrides).toHaveLength(1)
    expect(resolved.appliedOverrides[0]?.scope).toEqual({ accountId: STORE })
  })

  it('applies a page-type row only when a page type was asked about', () => {
    const rows = [row({ scope: { pageType: 'collection' }, key: DEMAND_FLOOR, value: 9 })]
    expect(
      config.resolve({ pageType: 'collection', overrides: rows }).layer.gates.demand_floor
        .monthly_search_volume_min,
    ).toBe(9)
    expect(() => config.resolve({ overrides: rows })).toThrow(RulesOverrideError)
  })

  it('refuses rows read for a different store rather than quietly skipping them', () => {
    expect(() =>
      config.resolve({
        accountId: STORE,
        overrides: [row({ scope: { accountId: 'someone-else' }, key: DEMAND_FLOOR, value: 1 })],
      }),
    ).toThrow(/do not apply to/)
  })
})

describe('a malformed override is refused, never ignored', () => {
  it('refuses a key that names no threshold', () => {
    expect(() =>
      config.resolve({
        overrides: [row({ key: 'gates.demand_floor.monthly_search_volume_typo', value: 1 })],
      }),
    ).toThrow(/is not a threshold this product has/)
  })

  it('refuses a key that names a whole group rather than one number', () => {
    expect(() => config.resolve({ overrides: [row({ key: 'gates.demand_floor', value: {} })] })).toThrow(
      /names a group of thresholds/,
    )
  })

  it('refuses a value of the wrong kind', () => {
    expect(() => config.resolve({ overrides: [row({ key: DEMAND_FLOOR, value: 'lots' })] })).toThrow(
      /is a number; this override supplies a string/,
    )
  })

  it('refuses a value the schema will not have, even though the key is real', () => {
    expect(() =>
      config.resolve({
        overrides: [row({ key: 'signals.content_decay.clicks_ratio_max', value: 4 })],
      }),
    ).toThrow(/invalid set of thresholds/)
  })

  it('refuses an override that puts a hole in the standard click curve', () => {
    expect(() =>
      config.resolve({
        overrides: [
          row({ key: 'ctr_curve.max_position', value: config.defaults.ctr_curve.max_position + 5 }),
        ],
      }),
    ).toThrow(/standard_curve is missing positions/)
  })
})

describe('the version stamped on a decision says which numbers made it', () => {
  it('stamps the plain file hash when the store is on the repo file', () => {
    expect(config.resolve({ locale: 'da-DK' }).rulesVersion).toBe(config.rulesVersion)
    expect(versionCarriesOverrides(config.resolve({ locale: 'da-DK' }).rulesVersion)).toBe(false)
  })

  it('stamps something else when an override is in play, keeping the file hash legible', () => {
    const stamped = config.resolve({
      accountId: STORE,
      overrides: [row({ scope: { accountId: STORE }, key: DEMAND_FLOOR, value: 42 })],
    }).rulesVersion
    expect(stamped).not.toBe(config.rulesVersion)
    expect(stamped.startsWith(`${config.rulesVersion}+ov.`)).toBe(true)
    expect(versionCarriesOverrides(stamped)).toBe(true)
  })

  it('gives two stores judged by the same numbers the same version', () => {
    const other = '22222222-2222-2222-2222-222222222222'
    const first = config.resolve({
      accountId: STORE,
      overrides: [row({ scope: { accountId: STORE }, key: DEMAND_FLOOR, value: 42 })],
    }).rulesVersion
    const second = config.resolve({
      accountId: other,
      overrides: [
        row({ scope: { accountId: other }, key: DEMAND_FLOOR, value: 42, updatedBy: 'someone.else' }),
      ],
    }).rulesVersion
    expect(second).toBe(first)
  })

  it('gives two stores judged by different numbers different versions', () => {
    const stamp = (value: number) =>
      config.resolve({
        accountId: STORE,
        overrides: [row({ scope: { accountId: STORE }, key: DEMAND_FLOOR, value })],
      }).rulesVersion
    expect(stamp(42)).not.toBe(stamp(43))
  })

  it('does not change the version when the losing row is the only thing that differs', () => {
    const winner = row({ scope: { accountId: STORE }, key: DEMAND_FLOOR, value: 42 })
    const withLoser = config.resolve({
      accountId: STORE,
      locale: 'en',
      overrides: [winner, row({ scope: { locale: 'en' }, key: DEMAND_FLOOR, value: 999 })],
    }).rulesVersion
    const alone = config.resolve({ accountId: STORE, locale: 'en', overrides: [winner] }).rulesVersion
    expect(withLoser).toBe(alone)
  })
})
