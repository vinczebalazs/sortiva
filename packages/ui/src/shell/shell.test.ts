import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AppShell } from './AppShell'
import { BannerStack } from './BannerStack'
import { LimitedIntelligenceBadge } from './LimitedIntelligenceBadge'
import { NavRail } from './NavRail'
import { MAX_VISIBLE_BANNERS, resolveBannerStack, type BannerContext } from './banners'
import { NAV_ITEMS, resolveNav, type NavContext } from './nav'
import { t } from '../strings'

const CONNECTED: NavContext = { domainState: 'ready_for_planning', firstScanComplete: true }
const CONNECTING: NavContext = { domainState: 'ingesting', firstScanComplete: false }

const HEALTHY: BannerContext = {
  subscriptionStatus: 'active',
  shopifyConnection: 'read',
  searchConsoleConnection: 'connected',
  limitedIntelligence: false,
  servicePaused: false,
  vacationMode: false,
}

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element)

// ── The six destinations ─────────────────────────────────────────────────────

describe('the navigation has six destinations', () => {
  it('names exactly the six the product decided on', () => {
    expect(NAV_ITEMS.map((item) => item.id)).toEqual([
      'dashboard',
      'opportunities',
      'content',
      'products',
      'performance',
      'settings',
    ])
  })

  it('renders six destinations and no more', () => {
    const html = render(createElement(NavRail, { context: CONNECTED }))
    // The two that fold under "More" on a phone are rendered twice — once in
    // the rail, once in the disclosure — so what is counted is the set of
    // destinations, not the number of elements.
    const rendered = new Set(
      [...html.matchAll(/data-nav-item="([a-z]+)"/g)].map((match) => match[1]),
    )
    expect([...rendered]).toHaveLength(6)
    expect(html).toContain('data-nav-destinations="6"')
  })

  it('labels every one of them from the string catalogue', () => {
    const html = render(createElement(NavRail, { context: CONNECTED }))
    for (const item of NAV_ITEMS) {
      expect(html).toContain(t(item.labelKey))
    }
  })

  it('folds the last two away on a phone, leaving four tabs', () => {
    expect(NAV_ITEMS.filter((item) => item.collapsesOnMobile).map((i) => i.id)).toEqual([
      'performance',
      'settings',
    ])
  })

  it('offers the folded pair under a "More" control that needs no scripts', () => {
    const html = render(createElement(NavRail, { context: CONNECTED }))
    expect(html).toContain('data-testid="nav-more"')
    // A disclosure element, so the navigation still opens if the page's
    // JavaScript never arrives.
    expect(html).toContain('<details')
    expect(html).toContain(t('nav.more'))
    // Both folded destinations appear twice: once in the rail for a desktop,
    // once inside the disclosure for a phone. Which is shown is the
    // stylesheet's business.
    expect(html.match(/data-nav-item="performance"/g)).toHaveLength(2)
    expect(html.match(/data-nav-item="settings"/g)).toHaveLength(2)
  })

  it('keeps a locked destination locked inside the "More" control too', () => {
    const html = render(createElement(NavRail, { context: CONNECTING }))
    expect(html.match(/data-nav-item="performance"[^>]*data-nav-status="locked"/g)).toHaveLength(2)
  })
})

// ── Locked before the store is connected ─────────────────────────────────────

describe('locked navigation before the store is connected', () => {
  it('locks the four product surfaces and leaves Dashboard and Settings reachable', () => {
    const locked = resolveNav(CONNECTING)
      .filter((item) => item.status === 'locked')
      .map((item) => item.id)
    expect(locked).toEqual(['opportunities', 'content', 'products', 'performance'])
  })

  for (const state of ['ingesting', 'awaiting_shopify_auth', 'needs_confirmation', 'unsupported'] as const) {
    it(`stays locked while the domain is ${state}`, () => {
      const locked = resolveNav({ domainState: state, firstScanComplete: false }).filter(
        (item) => item.status === 'locked',
      )
      expect(locked).toHaveLength(4)
    })
  }

  it('unlocks everything once the store is connected', () => {
    expect(resolveNav(CONNECTED).filter((item) => item.status === 'locked')).toEqual([])
  })

  it('renders a locked item as inert rather than as a link', () => {
    const html = render(createElement(NavRail, { context: CONNECTING }))
    // The lock has to be behavioural, not only visual: if these were anchors
    // with a grey colour, a keyboard or a screen reader would still reach them.
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toContain('href="/opportunities"')
    expect(html).toContain('href="/dashboard"')
    expect(html).toContain('href="/settings"')
  })

  it('says what would unlock it', () => {
    const html = render(createElement(NavRail, { context: CONNECTING }))
    expect(html).toContain(t('nav.lockedTooltip'))
  })

  it('keeps Opportunities marked as still filling until the first scan lands', () => {
    const html = render(
      createElement(NavRail, {
        context: { domainState: 'ready_for_planning', firstScanComplete: false },
      }),
    )
    expect(html).toContain('data-nav-pending="true"')
    expect(html).toContain(t('nav.opportunitiesPending'))
  })
})

// ── At most two banners ──────────────────────────────────────────────────────

describe('the banner stack shows at most two notices', () => {
  const everythingWrong: BannerContext = {
    subscriptionStatus: 'past_due',
    shopifyConnection: 'broken',
    searchConsoleConnection: 'broken',
    limitedIntelligence: true,
    servicePaused: true,
    vacationMode: true,
  }

  it('raises five notices but shows two', () => {
    const stack = resolveBannerStack(everythingWrong)
    expect(stack.visible).toHaveLength(MAX_VISIBLE_BANNERS)
    expect(stack.visible.map((b) => b.id)).toEqual(['payment_failed', 'shopify_reconnect'])
    expect(stack.overflow.map((b) => b.id)).toEqual([
      'service_paused',
      'vacation_mode',
      'gsc_reconnect',
    ])
  })

  it('renders two banner elements, never more', () => {
    const html = render(createElement(BannerStack, { context: everythingWrong }))
    expect(html.match(/data-banner="/g)).toHaveLength(2)
    expect(html).toContain('data-visible-banners="2"')
  })

  it('counts what it pushed out instead of hiding it silently', () => {
    const html = render(createElement(BannerStack, { context: everythingWrong }))
    expect(html).toContain('data-banner-overflow="3"')
    expect(html).toContain(t('banner.overflow.many', { count: 3 }))
  })

  it('renders nothing at all when nothing is wrong', () => {
    expect(render(createElement(BannerStack, { context: HEALTHY }))).toBe('')
  })

  it('lets a dismissible notice go and keeps a blocking one', () => {
    const context: BannerContext = {
      ...HEALTHY,
      limitedIntelligence: true,
      subscriptionStatus: 'past_due',
      dismissed: ['limited_intelligence', 'payment_failed'],
    }
    const stack = resolveBannerStack(context)
    expect(stack.visible.map((b) => b.id)).toEqual(['payment_failed'])
  })

  it('offers no dismiss control on a notice that stops the product working', () => {
    const html = render(
      createElement(BannerStack, { context: { ...HEALTHY, subscriptionStatus: 'past_due' } }),
    )
    expect(html).toContain('data-banner="payment_failed"')
    expect(html).not.toContain('sortiva-banner__dismiss')
  })

  it('does not say the same thing twice when Search Console is broken', () => {
    const stack = resolveBannerStack({
      ...HEALTHY,
      searchConsoleConnection: 'broken',
      limitedIntelligence: true,
    })
    expect(stack.visible.map((b) => b.id)).toEqual(['gsc_reconnect'])
  })

  it('offers no action on the outage notice, because there is nothing to click', () => {
    const html = render(createElement(BannerStack, { context: { ...HEALTHY, servicePaused: true } }))
    expect(html).toContain(t('banner.servicePaused'))
    expect(html).not.toContain('sortiva-banner__action')
  })
})

// ── Limited Intelligence badge ───────────────────────────────────────────────

describe('the Limited Intelligence badge', () => {
  it('uses the canonical sentence word for word', () => {
    const html = render(createElement(LimitedIntelligenceBadge, {}))
    expect(html).toContain(
      'Limited Intelligence — connect Search Console to see real query and page opportunities',
    )
  })

  it('lists what is not being evaluated, so "limited" is a specific claim', () => {
    const html = render(
      createElement(LimitedIntelligenceBadge, {
        unavailableSignals: ['Striking distance', 'Low click-through'],
      }),
    )
    expect(html).toContain('Striking distance')
    expect(html).toContain('Low click-through')
  })

  it('drops to the label alone in a header', () => {
    const html = render(createElement(LimitedIntelligenceBadge, { compact: true }))
    expect(html).toContain(t('badge.limitedIntelligence'))
    expect(html).not.toContain('connect Search Console to see real query')
  })
})

// ── The shell as a whole ─────────────────────────────────────────────────────

describe('the app shell', () => {
  it('wraps a screen in the rail and the notice strip', () => {
    const html = render(
      createElement(AppShell, {
        nav: CONNECTED,
        banners: { ...HEALTHY, subscriptionStatus: 'past_due' },
        children: createElement('p', { 'data-screen': 'true' }),
      }),
    )
    expect(html).toContain('data-testid="nav-rail"')
    expect(html).toContain('data-banner="payment_failed"')
    expect(html).toContain('data-screen="true"')
  })

  it('replaces the screen when the account is parked, and keeps the rail', () => {
    const html = render(
      createElement(AppShell, {
        nav: CONNECTING,
        banners: HEALTHY,
        children: createElement('p', { 'data-screen': 'true' }),
        parked: createElement('p', { 'data-parked-card': 'true' }),
      }),
    )
    expect(html).toContain('data-parked-card="true"')
    expect(html).not.toContain('data-screen="true"')
    expect(html).toContain('data-testid="nav-rail"')
    expect(html).toContain('href="/settings"')
  })
})

// ── No denominators anywhere the shell renders ───────────────────────────────

describe('nothing the shell renders states a count against a target', () => {
  it('renders no "x of y" or "x/y"', () => {
    const html = render(
      createElement(AppShell, {
        nav: { domainState: 'ready_for_planning', firstScanComplete: false },
        banners: {
          subscriptionStatus: 'past_due',
          shopifyConnection: 'broken',
          searchConsoleConnection: 'broken',
          limitedIntelligence: true,
          servicePaused: true,
          vacationMode: true,
        },
        children: null,
      }),
    )
    const text = html.replace(/<[^>]*>/g, ' ')
    expect(text).not.toMatch(/\b\d+\s*(of|\/)\s*\d+\b/)
  })
})
