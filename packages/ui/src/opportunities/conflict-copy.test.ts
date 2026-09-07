import { describe, expect, it } from 'vitest'
import { CONFLICT_CODES } from '@sortiva/core'
import en from '../../strings/en.json'
import { t } from '../strings'
import { CONFLICT_MESSAGE_KEYS, conflictMessage } from './actions'

/**
 * When the product refuses to do something, it tells the browser *which*
 * refusal it was — a short machine-readable code, one per outcome a merchant
 * needs to be told about specifically. Deleting the page you asked us to
 * improve is not the same event as another tab scheduling the topic first, and
 * the whole reason the API sends a code instead of a sentence is that the
 * screen can tell them apart.
 *
 * It could not. One code out of twenty-one had its own sentence; every other
 * refusal — including two added the same day the codes were — fell through to
 * "This opportunity was updated by the latest scan", which is untrue of nearly
 * all of them. The refusal travelled from the server perfectly and the browser
 * shrugged.
 *
 * The list is read from the contract rather than typed out here. A list someone
 * maintains by hand is exactly how the gap survived.
 */
describe('every refusal the API can name', () => {
  it('found the contract to check against', () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(CONFLICT_CODES.length).toBeGreaterThan(15)
  })

  it('has a sentence of its own, and it is not the fallback by accident', () => {
    const missing = CONFLICT_CODES.filter(
      (code) => (CONFLICT_MESSAGE_KEYS as Record<string, string | undefined>)[code] === undefined,
    )
    expect(
      missing,
      `these refusals reach the merchant as a generic error: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('reads back a real sentence from the catalogue for each one', () => {
    const catalogue = en as Record<string, string | undefined>
    const empty = CONFLICT_CODES.filter((code) => {
      const key = (CONFLICT_MESSAGE_KEYS as Record<string, string>)[code]!
      return (catalogue[key] ?? '').trim().length === 0
    })
    expect(
      empty,
      `these point at a string key with no sentence behind it in packages/ui/strings/en.json: ${empty.join(', ')}`,
    ).toEqual([])
  })

  it('is what the toast actually shows, code by code', () => {
    for (const code of CONFLICT_CODES) {
      const key = (CONFLICT_MESSAGE_KEYS as Record<string, string>)[code]!
      expect(conflictMessage(code), `the toast for ${code}`).toBe(t(key as never))
    }
  })

  it('uses the pinned outage wording when we paused rather than degrade', () => {
    // One of the dozen sentences the product may not reword; it says the same
    // thing wherever a merchant meets it.
    expect(conflictMessage('service_paused')).toBe(t('appendixA.outage'))
  })

  it('still says something for a refusal this build has never heard of', () => {
    // The fallback is kept on purpose — a code we do not know is far more
    // likely to be a stale frontend than a new failure — but it is now reached
    // only by codes outside the contract, never by declared ones.
    expect(conflictMessage('a_code_from_a_newer_server')).toBe(t('opportunities.toast.conflict'))
    expect(conflictMessage(null)).toBe(t('opportunities.toast.failed'))
  })
})
