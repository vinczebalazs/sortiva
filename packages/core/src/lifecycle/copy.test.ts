import { describe, expect, it } from 'vitest'
import { ACCOUNT_DELETION_CONFIRM_WORD, ACCOUNT_DELETION_FACTS } from './copy'

describe('the delete-account screen', () => {
  it('states the five facts word for word', () => {
    expect(ACCOUNT_DELETION_FACTS).toMatchInlineSnapshot(`
      [
        "Your subscription is cancelled immediately — there will be no further charges.",
        "Your published articles stay on your store. We never touch them.",
        "We hand back access to your Shopify store and your Search Console.",
        "Your domain stays reserved for 7 days, in case this was a mistake.",
        "Everything we hold about your store is erased within 30 days.",
      ]
    `)
  })

  it('names no count against a total', () => {
    // The same rule the monthly summary is held to: a ceiling is not a promise,
    // so nothing a merchant reads renders as "x of y".
    for (const fact of ACCOUNT_DELETION_FACTS) {
      expect(fact).not.toMatch(/\d+\s*(of|\/)\s*\d+/)
    }
  })

  it('asks the merchant to type the word back', () => {
    expect(ACCOUNT_DELETION_CONFIRM_WORD).toBe('DELETE')
  })
})
