import { describe, expect, it } from 'vitest'
import {
  CONFLICT_CODES,
  ENTITLEMENT_INACTIVE_CODE,
  RATE_LIMITED_CODE,
  ROUTES,
} from '@sortiva/core'
import en from '../../strings/en.json'
import { t } from '../strings'
import {
  CONFLICT_MESSAGE_KEYS,
  REFUSAL_CODES_AWAITING_COPY,
  REFUSAL_MESSAGE_KEYS,
  conflictMessage,
  createOpportunityActions,
  type ActionSurface,
  type OpportunitiesApi,
  type Toast,
} from './actions'
import type { OpportunityRow } from './types'

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

/**
 * Every code a route in the contract can refuse with — not only the conflict
 * enum.
 *
 * Two of them are not conflicts and are outside that enum on purpose: a lapsed
 * subscription answers 402, a rate limit answers 429. Both are found the same
 * way every other code is, by asking the route table which routes carry them,
 * because the browser reads a code off any failing response and cannot tell
 * which enum it came from. Checking only the enum is how those two went on
 * reading as a scan conflict after every conflict had been given words.
 */
function contractRefusalCodes(): readonly string[] {
  const codes = new Set<string>(CONFLICT_CODES)
  for (const route of ROUTES) {
    if (route.requiresEntitlement) codes.add(ENTITLEMENT_INACTIVE_CODE)
    if (route.rateLimited) codes.add(RATE_LIMITED_CODE)
  }
  return [...codes].sort()
}

describe('every refusal the API can name', () => {
  it('found the contract to check against', () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(CONFLICT_CODES.length).toBeGreaterThan(15)
    expect(ROUTES.length).toBeGreaterThan(20)
    // The two non-conflict refusals are reachable, so the check has to cover
    // them; if the contract ever stops carrying either, this says so rather
    // than quietly narrowing.
    expect(contractRefusalCodes()).toContain(ENTITLEMENT_INACTIVE_CODE)
    expect(contractRefusalCodes()).toContain(RATE_LIMITED_CODE)
  })

  it('has a sentence of its own, or is a named, deliberate gap', () => {
    const known = new Set<string>(REFUSAL_CODES_AWAITING_COPY)
    const missing = contractRefusalCodes().filter(
      (code) => REFUSAL_MESSAGE_KEYS[code] === undefined && !known.has(code),
    )
    expect(
      missing,
      `these refusals reach the merchant as a generic error: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('keeps the list of deliberate gaps honest in both directions', () => {
    const inContract = new Set(contractRefusalCodes())
    const notReal = REFUSAL_CODES_AWAITING_COPY.filter((code) => !inContract.has(code))
    expect(
      notReal,
      `no route can return these any more, so they should leave the awaiting-copy list: ${notReal.join(', ')}`,
    ).toEqual([])

    const written = REFUSAL_CODES_AWAITING_COPY.filter(
      (code) => REFUSAL_MESSAGE_KEYS[code] !== undefined,
    )
    expect(
      written,
      `these have been given a sentence and should leave the awaiting-copy list: ${written.join(', ')}`,
    ).toEqual([])
  })

  it('reads back a real sentence from the catalogue for each one', () => {
    const catalogue = en as Record<string, string | undefined>
    const empty = contractRefusalCodes().filter((code) => {
      const key = REFUSAL_MESSAGE_KEYS[code]
      return key !== undefined && (catalogue[key] ?? '').trim().length === 0
    })
    expect(
      empty,
      `these point at a string key with no sentence behind it in packages/ui/strings/en.json: ${empty.join(', ')}`,
    ).toEqual([])
  })

  it('is what the toast actually shows, code by code', () => {
    for (const code of contractRefusalCodes()) {
      const key = REFUSAL_MESSAGE_KEYS[code]
      if (key === undefined) continue
      expect(conflictMessage(code), `the toast for ${code}`).toBe(t(key))
    }
  })

  it('uses the pinned outage wording when we paused rather than degrade', () => {
    // One of the dozen sentences the product may not reword; it says the same
    // thing wherever a merchant meets it.
    expect(conflictMessage('service_paused')).toBe(t('appendixA.outage'))
  })

  it('says the same thing about a rate limit here as the preview screen does', () => {
    expect(conflictMessage(RATE_LIMITED_CODE)).toBe(t('preview.rateLimited'))
  })

  it('still says something for a refusal this build has never heard of', () => {
    // The fallback is kept on purpose — a code we do not know is far more
    // likely to be a stale frontend than a new failure — but it is now reached
    // only by codes outside the contract, never by declared ones.
    expect(conflictMessage('a_code_from_a_newer_server')).toBe(t('opportunities.toast.conflict'))
    expect(conflictMessage(null)).toBe(t('opportunities.toast.failed'))
  })

  it('leaves the money refusal wordless on purpose, and nothing else', () => {
    // Named rather than silently generic: what a lapsed subscriber should read
    // is billing copy, which this screen does not get to invent. Until it is
    // written they still meet the scan-conflict line, which is wrong, and this
    // test is where that is written down.
    expect(REFUSAL_CODES_AWAITING_COPY).toEqual([ENTITLEMENT_INACTIVE_CODE])
    expect(conflictMessage(ENTITLEMENT_INACTIVE_CODE)).toBe(t('opportunities.toast.conflict'))
  })
})

/**
 * The half of the round trip that was never checked.
 *
 * `R-REFUSAL` proved the server sends `optimize_no_target_query` and stopped
 * there; the browser received it perfectly and said something else. So these
 * press the buttons the way the screen presses them — through the same actions
 * object `OpportunitiesScreen` builds — and read the toast that comes back.
 */
const AT = '2026-02-02T09:00:00.000Z'

const row: OpportunityRow = {
  id: '22222222-2222-4222-8222-222222222222',
  signalType: 'striking_distance',
  entityRef: {
    kind: 'page',
    id: '/collections/trail-running',
    label: 'Collection: Trail running shoes',
  },
  recommendedAction: 'OPTIMIZE',
  status: 'new',
  impact: 'high',
  impactScore: 78,
  confidence: 'high',
  confidenceScore: 84,
  confidenceFactors: [],
  evidence: [{ key: 'impressions', value: 8400, source: 'gsc', window: '28d', fetchedAt: AT }],
  why: { templateKey: 'striking_distance.optimize', params: { position: 12.4, impressions: 320 } },
  preconditions: [],
  rulesVersion: 'a'.repeat(64),
  limitedIntelligence: false,
  detectedAt: AT,
  scheduledFor: null,
  expiresAt: null,
}

function refusing(code: string) {
  const toasts: Toast[] = []
  const api: OpportunitiesApi = {
    list: async () => null,
    detail: async () => null,
    post: async () => ({ ok: false, conflict: code }),
  }
  const surface: ActionSurface = {
    toast: (toast) => void toasts.push(toast),
    refresh: () => {},
    setHidden: () => {},
    setBusy: () => {},
  }
  return { actions: createOpportunityActions(api, surface), toasts }
}

describe('pressing a button on an opportunity the product will not act on', () => {
  it('says the page is gone, not that the page was re-scored', async () => {
    const scene = refusing('optimize_page_gone')
    await scene.actions.generate(row)
    expect(scene.toasts[0]?.message).toBe(
      'This page is no longer in your store, so there is nothing to improve.',
    )
  })

  it('says we cannot tell what the page competes for', async () => {
    const scene = refusing('optimize_no_target_query')
    await scene.actions.generate(row)
    expect(scene.toasts[0]?.message).toBe(
      "We can't tell which search this page competes for, so there's nothing to improve it against.",
    )
  })

  it('carries the same sentences through every other button on the card', async () => {
    for (const code of ['optimize_page_gone', 'optimize_no_target_query'] as const) {
      const scheduling = refusing(code)
      await scheduling.actions.schedule(row)
      expect(scheduling.toasts[0]?.message).toBe(conflictMessage(code))

      const dismissing = refusing(code)
      await dismissing.actions.dismiss(row)
      expect(dismissing.toasts[0]?.message).toBe(conflictMessage(code))

      const marking = refusing(code)
      await marking.actions.markTask(row, 'task-1', 'applied')
      expect(marking.toasts[0]?.message).toBe(conflictMessage(code))
    }
  })

  it('shows no toast that is still the old catch-all for a code we do have words for', async () => {
    const generic = t('opportunities.toast.conflict')
    for (const code of Object.keys(CONFLICT_MESSAGE_KEYS)) {
      if (code === 'opportunity_already_updated') continue
      const scene = refusing(code)
      await scene.actions.generate(row)
      expect(scene.toasts[0]?.message, `the toast for ${code}`).not.toBe(generic)
    }
  })
})
