import { BannerStack } from './BannerStack'
import { LimitedIntelligenceBadge } from './LimitedIntelligenceBadge'
import { NavRail } from './NavRail'
import { BANNERS, MAX_VISIBLE_BANNERS, type BannerContext } from './banners'

/**
 * Every state of the notice strip on one page, so the priority order, the
 * two-at-a-time rule and the dismissible/non-dismissible split can be looked at
 * rather than reasoned about. Rendered at a route that only exists outside
 * production.
 *
 * The headings here are scaffolding for whoever is looking at the page, not
 * product copy, which is why this file is exempt from the rule that keeps
 * sentences in the catalogue.
 */

const HEALTHY: BannerContext = {
  subscriptionStatus: 'active',
  shopifyConnection: 'read',
  searchConsoleConnection: 'connected',
  limitedIntelligence: false,
  servicePaused: false,
  vacationMode: false,
}

const CASES: readonly { title: string; note: string; context: BannerContext }[] = [
  {
    title: 'Nothing wrong',
    note: 'The strip renders nothing at all rather than an empty container.',
    context: HEALTHY,
  },
  {
    title: 'Payment failed',
    note: 'Critical, non-dismissible, and the only action is the billing portal.',
    context: { ...HEALTHY, subscriptionStatus: 'past_due' },
  },
  {
    title: 'Shopify connection lost',
    note: 'Non-dismissible: generation and scans are stopped until it is fixed.',
    context: { ...HEALTHY, shopifyConnection: 'broken' },
  },
  {
    title: 'Paused on our side',
    note: 'No action offered, because there is nothing the merchant can do.',
    context: { ...HEALTHY, servicePaused: true },
  },
  {
    title: 'Vacation mode on',
    note: 'Non-dismissible while it is on, so nobody wonders why nothing published.',
    context: { ...HEALTHY, vacationMode: true },
  },
  {
    title: 'Search Console lost',
    note: 'Dismissible: the product still works, it just knows less.',
    context: { ...HEALTHY, searchConsoleConnection: 'broken' },
  },
  {
    title: 'Limited Intelligence',
    note: 'Dismissible per session, and reappears as a badge on the screens that draw conclusions.',
    context: { ...HEALTHY, limitedIntelligence: true },
  },
  {
    title: 'Search Console lost and limited — one notice, not two',
    note: 'A broken connection suppresses the limited-mode notice; both would say the same thing.',
    context: { ...HEALTHY, searchConsoleConnection: 'broken', limitedIntelligence: true },
  },
  {
    title: 'Everything at once',
    note: 'Five are raised. Two are shown, in priority order, and the other three are counted.',
    context: {
      subscriptionStatus: 'past_due',
      shopifyConnection: 'broken',
      searchConsoleConnection: 'broken',
      limitedIntelligence: true,
      servicePaused: true,
      vacationMode: true,
    },
  },
  {
    title: 'Everything at once, the two dismissible ones dismissed',
    note: 'The count drops from three to two. The visible pair does not change, because neither of the top two can be dismissed at all.',
    context: {
      subscriptionStatus: 'past_due',
      shopifyConnection: 'broken',
      searchConsoleConnection: 'broken',
      limitedIntelligence: true,
      servicePaused: true,
      vacationMode: true,
      dismissed: ['gsc_reconnect', 'limited_intelligence'],
    },
  },
]

export function BannerStackPreview() {
  return (
    <div className="sortiva-preview">
      <h1>Banner stack</h1>
      <p>
        Priority order, highest first:{' '}
        {BANNERS.map((banner) => banner.id).join(' → ')}. At most {MAX_VISIBLE_BANNERS} are on
        screen; the rest are counted.
      </p>

      {CASES.map((example) => (
        <section key={example.title} className="sortiva-preview__case">
          <h2>{example.title}</h2>
          <p className="sortiva-preview__note">{example.note}</p>
          <BannerStack context={example.context} />
        </section>
      ))}

      <section className="sortiva-preview__case">
        <h2>Limited Intelligence badge</h2>
        <p className="sortiva-preview__note">Full form, then the compact header form.</p>
        <LimitedIntelligenceBadge
          unavailableSignals={[
            'Striking distance',
            'Low click-through',
            'Decay',
            'Cannibalization',
          ]}
        />
        <LimitedIntelligenceBadge compact />
      </section>

      <section className="sortiva-preview__case">
        <h2>Navigation rail — connected, connecting, and first scan running</h2>
        <p className="sortiva-preview__note">
          Four destinations lock until the store is connected; Opportunities keeps a spinner until
          the first scan lands.
        </p>
        <div className="sortiva-preview__rails">
          <NavRail context={{ domainState: 'ready_for_planning', firstScanComplete: true, currentItem: 'dashboard' }} />
          <NavRail context={{ domainState: 'ingesting', firstScanComplete: false }} />
          <NavRail context={{ domainState: 'ready_for_planning', firstScanComplete: false }} />
        </div>
      </section>
    </div>
  )
}
