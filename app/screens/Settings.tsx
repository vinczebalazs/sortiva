import { useEffect, useState } from 'react'
import type { DeliveryErrors, SettingsState } from '../../core/settings.ts'
import type { ProfileErrors, SetupState } from '../../core/setup.ts'
import { useHost } from '../shell/api.tsx'
import { Banner, Button, Card, Page, Stack, Switch } from '../ui/components.tsx'
import { formatMoment } from '../ui/format.ts'
import { DeliveryFields, ProfileFields, deliveryBody, deliveryForm, type DeliveryForm, type ProfileForm } from './forms.tsx'

type State = SettingsState & { profile: SetupState['profile'] }

/** Four sections on one page, each saving on its own. */
export function Settings({ onPauseChanged }: { onPauseChanged: () => void }) {
  const { t, get } = useHost()
  const [state, setState] = useState<State | null>(null)
  useEffect(() => {
    get<State>('/api/settings').then(setState)
  }, [])
  if (!state) return null
  return (
    <Page title={t.settings.title}>
      <ProfileSection state={state} onSaved={setState} />
      <PublishingSection state={state} onSaved={setState} />
      <SearchConsoleSection state={state} />
      <PauseSection state={state} onSaved={onPauseChanged} />
    </Page>
  )
}

function useSave<B, E>(onSaved: (s: State) => void) {
  const { post } = useHost()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [errors, setErrors] = useState<E>({} as E)
  const save = async (body: B) => {
    setSaving(true)
    setSaved(false)
    const res = await post<State | { errors: E }>('/api/settings', body)
    setSaving(false)
    if (res.status === 422) return setErrors((res.body as { errors: E }).errors)
    setErrors({} as E)
    setSaved(true)
    onSaved(res.body as State)
  }
  return { saving, saved, errors, save }
}

function SaveRow({ saving, saved, onSave }: { saving: boolean; saved: boolean; onSave: () => void }) {
  const { t } = useHost()
  return (
    <div className="ui-row">
      <Button primary disabled={saving} onClick={onSave}>{saving ? t.common.saving : t.common.save}</Button>
      {saved && <span className="ui-muted ui-small">{t.common.saved}</span>}
    </div>
  )
}

function ProfileSection({ state, onSaved }: { state: State; onSaved: (s: State) => void }) {
  const { t } = useHost()
  const p = state.profile
  const [form, setForm] = useState<ProfileForm>({ sells: p?.sells ?? '', audience: p?.audience ?? '', language: p?.language ?? 'en', country: p?.country ?? '', tone: p?.tone ?? 'plain', neverSay: p?.neverSay ?? '' })
  const { saving, saved, errors, save } = useSave<unknown, ProfileErrors>(onSaved)
  return (
    <Card title={t.settings.profile}>
      <Stack>
        <ProfileFields form={form} onChange={setForm} errors={errors} languageSupported />
        <p className="ui-muted ui-small" style={{ margin: 0 }}>{t.settings.profileHint}</p>
        <SaveRow saving={saving} saved={saved} onSave={() => save({ section: 'profile', profile: form })} />
      </Stack>
    </Card>
  )
}

function PublishingSection({ state, onSaved }: { state: State; onSaved: (s: State) => void }) {
  const { t } = useHost()
  const [form, setForm] = useState<DeliveryForm>(deliveryForm(state))
  const { saving, saved, errors, save } = useSave<unknown, DeliveryErrors>(onSaved)
  return (
    <Card title={t.settings.publishing}>
      <Stack>
        <DeliveryFields form={form} onChange={setForm} settings={state} errors={errors} />
        <SaveRow saving={saving} saved={saved} onSave={() => save({ section: 'delivery', delivery: deliveryBody(form) })} />
      </Stack>
    </Card>
  )
}

// Connect, disconnect and change property arrive with the Search Console client.
function SearchConsoleSection({ state }: { state: State }) {
  const { t, language } = useHost()
  const gsc = state.searchConsole
  return (
    <Card title={t.settings.searchConsole}>
      <Stack gap={12}>
        <p style={{ margin: 0 }}>{gsc.connected ? t.settings.connectedTo(gsc.property ?? '', formatMoment(gsc.since!, language)) : t.settings.notConnected}</p>
        {!gsc.connected && (
          <>
            <Banner>{t.searchConsole.connectSoon}</Banner>
            <div><Button disabled>{t.searchConsole.connect}</Button></div>
          </>
        )}
      </Stack>
    </Card>
  )
}

function PauseSection({ state, onSaved }: { state: State; onSaved: () => void }) {
  const { t } = useHost()
  const { saving, save } = useSave<unknown, Record<string, never>>(onSaved)
  return (
    <Card title={t.settings.pause}>
      <Stack gap={10}>
        <Switch id="pause" label={t.settings.pauseSwitch} checked={state.pausedByMerchant} disabled={saving} onChange={(paused) => save({ section: 'pause', paused })} />
        <p className="ui-muted ui-small" style={{ margin: 0 }}>{t.settings.pauseHint}</p>
        {state.pausedByUs && <p className="ui-small" style={{ margin: 0 }}>{t.settings.pausedByUs} {t.home.nothingWhy[state.pausedByUs]}</p>}
      </Stack>
    </Card>
  )
}
