import {
  LandingClosing,
  LandingFaq,
  LandingFooter,
  LandingHeader,
  LandingHeadlineStats,
  LandingHowItWorks,
  LandingPricing,
  LandingQualityBar,
  PreviewForm,
  t,
} from '@sortiva/ui'
import { loadPlan } from './_lib/plan'

/**
 * The landing page: one address field, and the card it produces.
 *
 * Its whole job is to turn a stranger into a signed-up merchant, so it never
 * dead-ends. A site we cannot read, a bot check that issued no token and an
 * endpoint that is down all land on the same card carrying the same invitation
 * as a successful one — there is no error state on this page at all.
 *
 * Nothing the preview produces is kept. It is a shop window, not a
 * measurement: none of it reaches the real ingestion that runs after a merchant
 * connects their store.
 */

const SIGN_IN = '/signin'

export default async function LandingPage() {
  const plan = await loadPlan()

  const getStarted = (
    <a className="sortiva-landing__primary" href={SIGN_IN}>
      {t('landing.nav.getStarted')}
    </a>
  )

  return (
    <>
      <div className="sortiva-public__width">
        <LandingHeader signinHref={SIGN_IN} />

        <section className="sortiva-landing__hero" id="preview">
          <div>
            <span className="sortiva-landing__tag">{t('landing.hero.eyebrow')}</span>
            <h1 className="sortiva-landing__title">{t('landing.hero.headline')}</h1>
            <p className="sortiva-landing__lead">{t('landing.hero.body')}</p>
            <LandingHeadlineStats />
          </div>
          <div>
            <PreviewForm
              turnstileSiteKey={process.env.TURNSTILE_SITE_KEY ?? null}
              signinHref={SIGN_IN}
            />
          </div>
        </section>

        <LandingHowItWorks />
        <LandingQualityBar />
        <LandingPricing plan={plan} action={getStarted} />
        <LandingFaq />
        <LandingClosing action={getStarted} />
        <LandingFooter />
      </div>
    </>
  )
}
