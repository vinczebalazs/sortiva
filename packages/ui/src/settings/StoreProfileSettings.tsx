'use client'

import { useState } from 'react'
import type { ProfileDraft } from '../onboarding/confirmation'
import {
  CompetitorsSection,
  FamiliesSection,
  KeywordsSection,
} from '../onboarding/ConfirmationSections'
import { t as defaultTranslate, type Translate } from '../strings'

/**
 * ui §9.2 — "the §3.7 confirmation screen, permanently editable": the same
 * components the confirmation review uses, kept live in Settings so grouping,
 * keywords and competitors never drift into a second copy.
 *
 * Keywords, competitors and the family report edit for real here, through the
 * same standing routes the confirmation screen calls — main §6.8 is explicit
 * that a keyword or competitor edit only re-runs its own enrichment, never a
 * full ingestion, and neither route knows or cares whether the account has
 * confirmed yet.
 *
 * The business profile (description, language, country, audience, tone) and
 * the ranked top-sellers are shown rather than made editable here: the only
 * write route for them, `POST /api/profile/confirm`, refuses a second call
 * once the store is confirmed (`profile_already_confirmed`), and nothing else
 * in the contract accepts a change to them. Recorded in `DECISIONS.md`
 * 2026-09-03 T9.7.
 */

export interface StoreProfileSettingsProps {
  readonly profile: ProfileDraft
  readonly t?: Translate
}

export function StoreProfileSettings({ profile, t = defaultTranslate }: StoreProfileSettingsProps) {
  const [keywords, setKeywords] = useState(profile.keywords)
  const [competitors, setCompetitors] = useState(profile.competitors)

  return (
    <section className="sortiva-settings__panel" data-settings-section="profile">
      <h1>{t('settings.profile.heading')}</h1>
      <p className="sortiva-settings__note">{t('settings.profile.intro')}</p>

      <section className="sortiva-confirm__section" data-setting="store_profile">
        <h2>{t('settings.profile.business.heading')}</h2>
        <dl className="sortiva-settings__facts">
          <dt>{t('settings.profile.business.description')}</dt>
          <dd>{profile.description}</dd>
          <dt>{t('settings.profile.business.language')}</dt>
          <dd>{profile.language}</dd>
          <dt>{t('settings.profile.business.country')}</dt>
          <dd>{profile.country}</dd>
          <dt>{t('settings.profile.business.audience')}</dt>
          <dd>{profile.audience}</dd>
          <dt>{t('settings.profile.business.tone')}</dt>
          <dd>{profile.tone}</dd>
        </dl>
        <p className="sortiva-settings__note">{t('settings.profile.readOnlyNote')}</p>
      </section>

      <KeywordsSection keywords={keywords} onChange={setKeywords} t={t} />
      <CompetitorsSection
        competitors={competitors}
        suggestions={profile.competitorSuggestions}
        onChange={setCompetitors}
        t={t}
      />
      <FamiliesSection families={profile.families} t={t} />
    </section>
  )
}
