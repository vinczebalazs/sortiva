import { useEffect, useState } from 'react'
import type { ProfileErrors, SetupState } from '../../core/setup.ts'
import { useHost } from '../shell/api.tsx'
import { Banner, Button, Card, Checklist, Choices, Page, Progress, Select, Stack, Tag, TextField } from '../ui/components.tsx'

const STEPS = 4
const POLL_MS = 2000

/** The four-step first-run flow. It resumes wherever the store is, because the step lives on the server. */
export function Setup({ onDone }: { onDone?: () => void }) {
  const { get } = useHost()
  const [state, setState] = useState<SetupState | null>(null)

  useEffect(() => {
    let stop = false
    const load = async () => {
      const next = await get<SetupState>('/api/setup')
      if (stop) return
      setState(next)
      if (next.step === 'reading') setTimeout(load, POLL_MS)
      if (next.step === 'done') onDone?.()
    }
    load()
    return () => {
      stop = true
    }
  }, [])

  if (!state) return null
  switch (state.step) {
    case 'reading':
      return <ReadingStore state={state} />
    case 'no_products':
      return <NoProducts />
    case 'profile':
      return <ConfirmProfile state={state} onConfirmed={setState} />
    default:
      return <AfterProfile />
  }
}

function ReadingStore({ state }: { state: SetupState }) {
  const { t } = useHost()
  const { products, facts, profile } = state.reading
  const stateOf = (complete: boolean, active: boolean): 'done' | 'active' | 'todo' => (complete ? 'done' : active ? 'active' : 'todo')
  const items = [
    { label: t.reading.products(products.done, products.total), state: stateOf(products.complete, !products.complete) },
    { label: t.reading.facts, state: stateOf(facts.complete, products.complete && !facts.complete), aside: t.reading.factsDetail(facts.done, facts.total) },
    { label: t.reading.profile, state: stateOf(profile.complete, facts.complete && !profile.complete) },
  ]
  const fraction = (products.complete ? 1 : products.total ? products.done / products.total : 0) / 3 + (facts.complete ? 1 : facts.total ? facts.done / facts.total : 0) / 3 + (profile.complete ? 1 / 3 : 0)
  return (
    <Page label={t.stepOf(1, STEPS)} title={t.reading.title} subtitle={t.reading.subtitle}>
      <Card>
        <Stack gap={12}>
          <Checklist items={items} />
          <Progress value={fraction} />
        </Stack>
      </Card>
    </Page>
  )
}

function NoProducts() {
  const { t, adminLink } = useHost()
  return (
    <Page label={t.stepOf(1, STEPS)} title={t.noProducts.title}>
      <Card>
        <Stack>
          <p style={{ margin: 0 }}>{t.noProducts.body}</p>
          <div>
            <a className="ui-button" data-primary href={adminLink('products')} target="_top">{t.noProducts.action}</a>
          </div>
        </Stack>
      </Card>
    </Page>
  )
}

function ConfirmProfile({ state, onConfirmed }: { state: SetupState; onConfirmed: (s: SetupState) => void }) {
  const { t, post } = useHost()
  const draft = state.profile
  const [form, setForm] = useState({
    sells: draft?.sells ?? '',
    audience: draft?.audience ?? '',
    language: state.storeLanguageSupported ? (draft?.language ?? 'en') : '',
    country: draft?.country ?? '',
    tone: draft?.tone ?? 'plain',
    neverSay: draft?.neverSay ?? '',
  })
  const [errors, setErrors] = useState<ProfileErrors>({})
  const [saving, setSaving] = useState(false)
  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }))
  const message = (e?: 'required' | 'unsupported') => (e === 'required' ? t.profile.required : e === 'unsupported' ? t.profile.unsupported : undefined)

  const confirm = async () => {
    setSaving(true)
    const res = await post<SetupState | { errors: ProfileErrors }>('/api/setup', form)
    setSaving(false)
    if (res.status === 422) setErrors((res.body as { errors: ProfileErrors }).errors)
    else onConfirmed(res.body as SetupState)
  }

  return (
    <Page
      label={t.stepOf(2, STEPS)}
      title={t.profile.title}
      subtitle={t.profile.subtitle}
      actions={<Button primary disabled={saving} onClick={confirm}>{saving ? t.profile.saving : t.profile.confirm}</Button>}
    >
      <Card aside={<Tag tone="primary">{t.profile.draft}</Tag>}>
        <Stack>
          <TextField id="sells" label={t.profile.sells} value={form.sells} onChange={set('sells')} multiline error={message(errors.sells)} />
          <TextField id="audience" label={t.profile.audience} value={form.audience} onChange={set('audience')} multiline error={message(errors.audience)} />
          {!state.storeLanguageSupported && <Banner tone="warning">{t.profile.languageUnsupported}</Banner>}
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
      </Card>
    </Page>
  )
}

// Steps 3 and 4 (Search Console, delivery) are the next phase's screens.
function AfterProfile() {
  const { t } = useHost()
  return (
    <Page label={t.stepOf(3, STEPS)} title={t.next.title}>
      <Card>
        <p style={{ margin: 0 }}>{t.next.body}</p>
      </Card>
    </Page>
  )
}
