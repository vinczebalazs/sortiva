import { describe, expect, it } from 'vitest'
import { RESPONSE_FIXTURES } from '../msw/fixtures'
import { navContextFromAccount, bannerContextFromAccount, type ShellAccount } from '../shell'
import { SCREEN_FIXTURE_DEPENDENCIES, readPath } from './screen-contract'

describe('every field a built screen depends on exists in the mock response', () => {
  for (const dependency of SCREEN_FIXTURE_DEPENDENCIES) {
    for (const field of dependency.fields) {
      it(`${dependency.route} answers ${field} — ${dependency.screen}`, () => {
        const body = RESPONSE_FIXTURES[dependency.route]
        expect(body, `no fixture for ${dependency.route}`).toBeDefined()
        expect(readPath(body, field)).not.toBeUndefined()
      })
    }
  }
})

describe('the shell reads the mock account into the right state', () => {
  const account = RESPONSE_FIXTURES['GET /api/account'] as unknown as ShellAccount

  it('unlocks the navigation for a connected, scanned store', () => {
    expect(navContextFromAccount(account)).toMatchObject({
      domainState: 'ready_for_planning',
      firstScanComplete: true,
    })
  })

  it('raises no banners for a healthy account', () => {
    expect(bannerContextFromAccount(account)).toMatchObject({
      subscriptionStatus: 'active',
      shopifyConnection: 'read',
      searchConsoleConnection: 'connected',
      limitedIntelligence: false,
      servicePaused: false,
      vacationMode: false,
    })
  })

  it('treats an account with no domain as not connected rather than crashing', () => {
    expect(navContextFromAccount({ ...account, domain: null }).domainState).toBe('none')
  })
})
