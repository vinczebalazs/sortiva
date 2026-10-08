import { useEffect, useState } from 'react'
import type { ProfileErrors, SetupState } from '../../core/setup.ts'
import { useHost } from '../shell/api.tsx'
import type { DeliveryErrors, SettingsState } from '../../core/settings.ts'
import { Banner, Button, Card, Checklist, Page, Progress, Stack, Tag } from '../ui/components.tsx'
import { DeliveryFields, ProfileFields, deliveryBody, deliveryForm, type DeliveryForm, type ProfileForm } from './forms.tsx'

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

  const next = (s: SetupState) => {
    setState(s)
    if (s.step === 'done') onDone?.()
  }

  if (!state) return null
  switch (state.step) {
    case 'reading':
      return <ReadingStore state={state} />
    case 'no_products':
      return <NoProducts />
    case 'profile':
      return <ConfirmProfile state={state} onConfirmed={setState} />
    case 'search_console':
      return <SearchConsoleStep onDone={setState} />
    case 'delivery':
      return <DeliveryStep onDone={next} />
    case 'done':
      return null
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
  const [form, setForm] = useState<ProfileForm>({
    sells: draft?.sells ?? '',
    audience: draft?.audience ?? '',
    language: state.storeLanguageSupported ? (draft?.language ?? 'en') : '',
    country: draft?.country ?? '',
    tone: draft?.tone ?? 'plain',
    neverSay: draft?.neverSay ?? '',
  })
  const [errors, setErrors] = useState<ProfileErrors>({})
  const [saving, setSaving] = useState(false)

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
        <ProfileFields form={form} onChange={setForm} errors={errors} languageSupported={state.storeLanguageSupported} />
      </Card>
    </Page>
  )
}

// Connecting is built with the Search Console client; until then only "Skip for now" works.
function SearchConsoleStep({ onDone }: { onDone: (s: SetupState) => void }) {
  const { t, post } = useHost()
  const [busy, setBusy] = useState(false)
  const skip = async () => {
    setBusy(true)
    onDone((await post<SetupState>('/api/setup/search-console', {})).body)
  }
  return (
    <Page label={t.stepOf(3, STEPS)} title={t.searchConsole.title} subtitle={t.searchConsole.subtitle}>
      <Card>
        <Stack>
          <p style={{ margin: 0 }}>{t.searchConsole.body}</p>
          <Banner>{t.searchConsole.connectSoon}</Banner>
          <div className="ui-row">
            <Button primary disabled>{t.searchConsole.connect}</Button>
            <Button ghost disabled={busy} onClick={skip}>{t.searchConsole.skip}</Button>
          </div>
        </Stack>
      </Card>
    </Page>
  )
}

function DeliveryStep({ onDone }: { onDone: (s: SetupState) => void }) {
  const { t, get, post } = useHost()
  const [settings, setSettings] = useState<SettingsState | null>(null)
  const [form, setForm] = useState<DeliveryForm | null>(null)
  const [errors, setErrors] = useState<DeliveryErrors>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    get<SettingsState>('/api/settings').then((s) => {
      setSettings(s)
      setForm(deliveryForm(s))
    })
  }, [])
  if (!settings || !form) return null

  const finish = async () => {
    setSaving(true)
    const res = await post<SetupState | { errors: DeliveryErrors }>('/api/setup/delivery', deliveryBody(form))
    setSaving(false)
    if (res.status === 422) setErrors((res.body as { errors: DeliveryErrors }).errors)
    else onDone(res.body as SetupState)
  }

  return (
    <Page
      label={t.stepOf(4, STEPS)}
      title={t.delivery.title}
      actions={<Button primary disabled={saving} onClick={finish}>{saving ? t.common.saving : t.delivery.finish}</Button>}
    >
      <Card>
        <DeliveryFields form={form} onChange={setForm} settings={settings} errors={errors} />
      </Card>
    </Page>
  )
}
