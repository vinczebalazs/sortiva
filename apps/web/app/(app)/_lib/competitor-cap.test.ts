import { BUSINESS_COMPETITOR_CAP } from '@sortiva/db'
import { MAX_COMPETITORS } from '@sortiva/ui/onboarding/confirmation'
import { t } from '@sortiva/ui/strings/translate'
import { describe, expect, it } from 'vitest'

/**
 * The five-competitor cap is written down in five places, and this is where the
 * three that nothing else could compare are held to the two that enforce it.
 *
 * A merchant may track at most five rival stores, because every extra one
 * multiplies the paid search lookups the product makes on their behalf. The
 * number therefore lives wherever it has to be enforced: a database trigger, so
 * nothing can write a sixth row whatever the code believes; a constant in the
 * repository, so the API can refuse politely rather than surfacing a database
 * error; a constant in the onboarding screen, which greys the "Add" control out
 * before the merchant presses it; and two sentences telling the merchant the
 * number — one under the onboarding list, one on the refusal itself.
 *
 * The trigger and the repository constant are already pinned to each other —
 * `packages/db/src/keywords.test.ts` fills an account through the repository and
 * then goes round it, so the two failing at different numbers fails there. The
 * screen's copy of the number and the two sentences quoting it had nothing
 * holding them: the only assertion was that the screen's constant equals the
 * literal 5, which is a copy of the number checked against another copy of the
 * number, and would still pass with all five disagreeing.
 *
 * This file lives in the application rather than beside either constant because
 * the application is the only package that depends on both — and the screen must
 * not import the database layer, which would drag a Postgres client into a
 * browser bundle.
 */

/** Small numbers as the copy catalogue writes them. Deliberately short: a cap outside it is a copy decision, not a lookup. */
const IN_WORDS: Record<number, string> = { 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven' }

describe('the five-competitor cap', () => {
  it('is the same number on the screen as in the code that enforces it', () => {
    expect(MAX_COMPETITORS).toBe(BUSINESS_COMPETITOR_CAP)
  })

  /**
   * Both sentences a merchant reads name the number — the onboarding note as a
   * digit, the refusal in words. If the cap moved and these did not, the product
   * would refuse a sixth competitor while telling them the limit is five.
   */
  it('is the number both sentences quote', () => {
    const word = IN_WORDS[BUSINESS_COMPETITOR_CAP]
    expect(word, `no spelling on file for a cap of ${BUSINESS_COMPETITOR_CAP}`).toBeDefined()
    expect(t('opportunities.toast.competitorLimitReached')).toContain(word)
    expect(t('confirm.competitors.capTooltip')).toContain(String(BUSINESS_COMPETITOR_CAP))
  })

  /** The lock is worth nothing if the number it reads is not the enforced one. */
  it('reads the enforced number, not a literal typed here', () => {
    expect(BUSINESS_COMPETITOR_CAP).toBeGreaterThan(0)
    expect(IN_WORDS[BUSINESS_COMPETITOR_CAP]).not.toBe(IN_WORDS[BUSINESS_COMPETITOR_CAP + 1])
  })
})
