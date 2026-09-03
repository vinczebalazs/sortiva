import { describe, expect, it } from 'vitest'
import { containsCurrencyFigure, currencyFiguresIn, placeholdersIn } from './product-refs'

describe('containsCurrencyFigure', () => {
  it('catches symbol-prefixed and symbol-suffixed amounts', () => {
    expect(containsCurrencyFigure('Priced at $49.99 today.')).toBe(true)
    expect(containsCurrencyFigure('It costs 49,99 € in most stores.')).toBe(true)
    expect(containsCurrencyFigure('Available for £120.')).toBe(true)
  })

  it('catches an amount followed by a currency code or abbreviation', () => {
    expect(containsCurrencyFigure('This one is 20 USD cheaper.')).toBe(true)
    expect(containsCurrencyFigure('Listed at 349 kr.')).toBe(true)
  })

  it('does not flag an ordinary measurement', () => {
    expect(containsCurrencyFigure('The tank holds 20 litres.')).toBe(false)
    expect(containsCurrencyFigure('It weighs 1.2 kg and fits 30 items.')).toBe(false)
    expect(containsCurrencyFigure('Rated for 300 kg.')).toBe(false)
  })

  it('does not flag a product-reference placeholder token, which is the point of having one', () => {
    expect(containsCurrencyFigure('The {{p1}} is the better value.')).toBe(false)
  })

  it('currencyFiguresIn reports every match for a diagnostic message', () => {
    expect(currencyFiguresIn('From $49.99 up to $129.99.')).toEqual(['$49.99', '$129.99'])
  })
})

describe('placeholdersIn', () => {
  it('extracts every {{id}} token in order, duplicates included', () => {
    expect(placeholdersIn('See {{p1}} and {{p2}}, or again {{p1}}.')).toEqual(['p1', 'p2', 'p1'])
  })

  it('returns nothing for prose with no tokens', () => {
    expect(placeholdersIn('Plain text.')).toEqual([])
  })
})
