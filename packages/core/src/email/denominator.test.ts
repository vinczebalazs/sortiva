import { describe, expect, it } from 'vitest'
import { assertNoDenominator, assertNoNumericDenominator, findDenominator } from './denominator'

describe('the denominator rule', () => {
  it('rejects a count stated against a total', () => {
    expect(findDenominator('This month: 22 of 30 articles published.')?.finding).toContain('"of"')
    expect(findDenominator('22/30 articles')?.finding).toContain('slash')
    expect(findDenominator('You used 22 out of 30.')?.finding).toBeTruthy()
    expect(findDenominator('4 in 30 days')?.finding).toContain('total')
  })

  it('rejects target vocabulary, because a ceiling is not a goal', () => {
    for (const line of [
      'You have 8 articles remaining this month.',
      'Your monthly target is 30 articles.',
      'Your quota resets on the first.',
      'We published only 22 articles.',
    ]) {
      expect(findDenominator(line), line).toBeTruthy()
    }
  })

  it('accepts a plain report of what happened', () => {
    expect(() =>
      assertNoDenominator(
        'This month: 22 articles went live on your store. 5 topics were held back by our quality bar — here is each one and why.',
      ),
    ).not.toThrow()
  })

  it('does not read a link as a fraction', () => {
    // `https://sortiva.app/settings` has two slashes and says nothing about
    // how much we published.
    expect(() =>
      assertNoDenominator('Open your dashboard: https://sortiva.app/settings/notifications'),
    ).not.toThrow()
  })

  it('names the sentence it objected to, not the file', () => {
    const found = findDenominator('Great month. You published 22 of 30 planned articles.')
    expect(found?.excerpt).toContain('22 of 30')
  })

  it('lets every other template say "one of your articles" but never a total', () => {
    expect(() => assertNoNumericDenominator('One of your articles needs a small fix.')).not.toThrow()
    expect(() => assertNoNumericDenominator('3 of 30 articles need a fix.')).toThrow()
  })
})
