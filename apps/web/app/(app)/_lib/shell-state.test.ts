import { describe, expect, it } from 'vitest'
import { navContextFromAccount, bannerContextFromAccount, resolveLanguage } from '@sortiva/ui'
import { RESPONSE_FIXTURES } from '@sortiva/ui/msw'
import { buildShellState, parseAcceptLanguage, type ShellRequest } from './shell-state'

const REQUEST: ShellRequest = {
  cookie: 'session=abc',
  origin: 'http://localhost:3000',
  acceptLanguage: 'en-GB,en;q=0.9,fr;q=0.8',
}

const answering =
  (bodies: Record<string, unknown>) =>
  async <T>(path: string): Promise<T | null> =>
    (bodies[path] as T) ?? null

describe('the frame degrades rather than failing', () => {
  it('locks everything and raises nothing when the account cannot be read', async () => {
    const state = await buildShellState(REQUEST, answering({}))

    expect(navContextFromAccount(state.account).domainState).toBe('none')
    const banners = bannerContextFromAccount(state.account)
    expect(banners.subscriptionStatus).toBe('none')
    expect(banners.servicePaused).toBe(false)
  })

  it('still renders the frame when only the settings endpoint is missing', async () => {
    const state = await buildShellState(
      REQUEST,
      answering({ '/api/account': RESPONSE_FIXTURES['GET /api/account'] }),
    )

    expect(state.settings).toBeNull()
    expect(navContextFromAccount(state.account).domainState).toBe('ready_for_planning')
    expect(bannerContextFromAccount(state.account, { vacationMode: false }).vacationMode).toBe(false)
  })

  it('reads both responses when both answer', async () => {
    const state = await buildShellState(
      REQUEST,
      answering({
        '/api/account': RESPONSE_FIXTURES['GET /api/account'],
        '/api/settings': RESPONSE_FIXTURES['GET /api/settings'],
      }),
    )

    expect(state.settings?.vacationMode).toBe(false)
    expect(navContextFromAccount(state.account).firstScanComplete).toBe(true)
  })
})

describe('interface language from the request', () => {
  it('reads the browser ordering out of the header, quality values and all', () => {
    expect(parseAcceptLanguage('en-GB,en;q=0.9,fr;q=0.8')).toEqual(['en-GB', 'en', 'fr'])
  })

  it('treats a missing or wildcard header as no preference', () => {
    expect(parseAcceptLanguage(null)).toEqual([])
    expect(parseAcceptLanguage('*')).toEqual([])
  })

  it('lands on English for a browser asking for a language we do not ship', async () => {
    const state = await buildShellState({ ...REQUEST, acceptLanguage: 'hu-HU,hu;q=0.9' }, answering({}))
    expect(resolveLanguage({ saved: null, browser: state.acceptLanguage })).toBe('en')
  })
})
