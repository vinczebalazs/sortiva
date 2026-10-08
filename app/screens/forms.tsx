import type { DeliveryErrors, SettingsState } from '../../core/settings.ts'
import type { ProfileErrors } from '../../core/setup.ts'
import { useHost } from '../shell/api.tsx'
import { Banner, Checkbox, Choices, Select, Stack, TextField } from '../ui/components.tsx'

export type ProfileForm = { sells: string; audience: string; language: string; country: string; tone: string; neverSay: string }

export function ProfileFields({ form, onChange, errors, languageSupported }: { form: ProfileForm; onChange: (f: ProfileForm) => void; errors: ProfileErrors; languageSupported: boolean }) {
  const { t } = useHost()
  const set = (key: keyof ProfileForm) => (value: string) => onChange({ ...form, [key]: value })
  const message = (e?: 'required' | 'unsupported') => (e === 'required' ? t.profile.required : e === 'unsupported' ? t.profile.unsupported : undefined)
  return (
    <Stack>
      <TextField id="sells" label={t.profile.sells} value={form.sells} onChange={set('sells')} multiline error={message(errors.sells)} />
      <TextField id="audience" label={t.profile.audience} value={form.audience} onChange={set('audience')} multiline error={message(errors.audience)} />
      {!languageSupported && <Banner tone="warning">{t.profile.languageUnsupported}</Banner>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Select
          id="language"
          label={t.profile.language}
          value={form.language}
          onChange={set('language')}
          error={message(errors.language)}
          options={[...(form.language ? [] : [{ value: '', label: '—' }]), { value: 'en', label: t.languages.en }, { value: 'hu', label: t.languages.hu }]}
        />
        <TextField id="country" label={t.profile.country} hint={t.profile.countryHint} value={form.country} onChange={set('country')} error={message(errors.country)} />
      </div>
      <Choices
        name="tone"
        label={t.profile.tone}
        value={form.tone}
        onChange={set('tone')}
        options={(['plain', 'friendly', 'expert'] as const).map((v) => ({ value: v, ...t.profile.tones[v] }))}
      />
      <TextField id="never-say" label={t.profile.neverSay} hint={t.profile.neverSayHint} value={form.neverSay} onChange={set('neverSay')} multiline />
    </Stack>
  )
}

export type DeliveryForm = { mode: 'export' | 'auto_publish'; blog: string; publishAs: 'live' | 'draft'; publishHour: number; reviewFirst: boolean }

export function deliveryForm(settings: SettingsState): DeliveryForm {
  const d = settings.delivery
  return { mode: d.mode, blog: d.blogId ?? (d.blogToCreate ? 'create' : (settings.blogs[0]?.id ?? 'create')), publishAs: d.publishAs, publishHour: d.publishHour, reviewFirst: d.reviewFirst }
}

/** The body the API takes for setup step 4 and the Settings "Publishing" section. */
export function deliveryBody(form: DeliveryForm) {
  return { ...form, blog: form.mode === 'auto_publish' ? form.blog : null, newBlogTitle: 'Blog' }
}

export function DeliveryFields({ form, onChange, settings, errors }: { form: DeliveryForm; onChange: (f: DeliveryForm) => void; settings: SettingsState; errors: DeliveryErrors }) {
  const { t } = useHost()
  const d = t.delivery
  const set = <K extends keyof DeliveryForm>(key: K, value: DeliveryForm[K]) => onChange({ ...form, [key]: value })
  const blogOptions = [...settings.blogs.map((b) => ({ value: b.id, label: b.title })), { value: 'create', label: d.createBlog(settings.delivery.blogToCreate ?? 'Blog') }]
  return (
    <Stack>
      <Choices
        name="mode"
        label={t.settings.publishing}
        value={form.mode}
        onChange={(v) => onChange({ ...form, mode: v as DeliveryForm['mode'], reviewFirst: v === 'auto_publish' })}
        options={[
          { value: 'export', ...d.export },
          { value: 'auto_publish', ...d.autoPublish },
        ]}
      />
      {form.mode === 'auto_publish' && (
        <>
          <Select id="blog" label={d.blog} value={form.blog} onChange={(v) => set('blog', v)} options={blogOptions} error={errors.blog ? d.blogRequired : undefined} />
          <Choices
            name="publish-as"
            label={d.publishAs}
            value={form.publishAs}
            onChange={(v) => set('publishAs', v as DeliveryForm['publishAs'])}
            options={[
              { value: 'live', ...d.live },
              { value: 'draft', ...d.draft },
            ]}
          />
          <Select
            id="publish-hour"
            label={d.publishHour}
            hint={d.publishHourHint(settings.timezone)}
            value={String(form.publishHour)}
            onChange={(v) => set('publishHour', Number(v))}
            options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }))}
          />
        </>
      )}
      <Checkbox id="review-first" label={d.reviewFirst} checked={form.reviewFirst} onChange={(v) => set('reviewFirst', v)} />
    </Stack>
  )
}
