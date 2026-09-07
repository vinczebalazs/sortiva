'use client'

import { useEffect, useState } from 'react'
import { t as defaultTranslate, type Translate } from '../strings'
import {
  formatHour,
  phaseAfterDeliveryConflict,
  PUBLISH_HOURS,
  showsAutoRepair,
  showsTargetBlog,
  timezoneOptions,
  type WriteGrantPhase,
} from './settings'
import type { DeliveryMode } from '../content/types'
import type { AccountSettingsData, PublishAs, ShopifyBlog } from './types'

/**
 * ui §9.1 — how a store's articles reach the world.
 *
 * Every control saves itself the moment it changes: there is no separate Save
 * button, so a merchant never wonders whether a flipped switch actually took.
 * Turning delivery to Auto is the one control that is not a plain save — it
 * runs the §9.5 flow inline (write-scope grant, then a target blog) before the
 * setting actually takes, and this component is where those two conflict
 * codes turn into the two inline cards the merchant sees.
 */

export interface PublishingSettingsProps {
  readonly settings: AccountSettingsData
  readonly country: string | null
  readonly t?: Translate
  readonly patchEndpoint?: string
  readonly writeGrantEndpoint?: string
  readonly blogsEndpoint?: string
  readonly selectBlogEndpoint?: string
}

async function patchSettings(
  endpoint: string,
  patch: Partial<AccountSettingsData>,
): Promise<{ ok: true; settings: AccountSettingsData } | { ok: false; code: string | null }> {
  try {
    const response = await fetch(endpoint, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (response.ok) return { ok: true, settings: (await response.json()) as AccountSettingsData }
    if (response.status === 409) {
      const body = (await response.json()) as { error?: { code?: string } }
      return { ok: false, code: body.error?.code ?? null }
    }
    return { ok: false, code: null }
  } catch {
    return { ok: false, code: null }
  }
}

export function PublishingSettings({
  settings: initial,
  country,
  t = defaultTranslate,
  patchEndpoint = '/api/settings',
  writeGrantEndpoint = '/api/publish/grant/start',
  blogsEndpoint = '/api/publish/blogs',
  selectBlogEndpoint = '/api/publish/target',
}: PublishingSettingsProps) {
  const [settings, setSettings] = useState(initial)
  const [phase, setPhase] = useState<WriteGrantPhase>({ kind: 'idle' })
  const [blogs, setBlogs] = useState<readonly ShopifyBlog[]>([])
  const [newBlogName, setNewBlogName] = useState('')
  const [savedNote, setSavedNote] = useState<string | null>(null)

  const zones = timezoneOptions(country)

  function flash(key: 'settings.publishing.saved' | 'settings.publishing.saveFailed') {
    setSavedNote(t(key))
    setTimeout(() => setSavedNote(null), 3000)
  }

  async function save(patch: Partial<AccountSettingsData>) {
    const previous = settings
    setSettings({ ...settings, ...patch })
    const result = await patchSettings(patchEndpoint, patch)
    if (result.ok) {
      setSettings(result.settings)
      flash('settings.publishing.saved')
    } else {
      setSettings(previous)
      flash('settings.publishing.saveFailed')
    }
  }

  async function setDelivery(next: DeliveryMode) {
    if (next === 'export') {
      setPhase({ kind: 'idle' })
      await save({ delivery: 'export' })
      return
    }

    setPhase({ kind: 'saving' })
    const result = await patchSettings(patchEndpoint, { delivery: 'auto' })
    if (result.ok) {
      setSettings(result.settings)
      setPhase({ kind: 'idle' })
      flash('settings.publishing.saved')
      return
    }
    setPhase(phaseAfterDeliveryConflict(result.code))
  }

  async function requestWriteGrant() {
    setPhase({ kind: 'granting' })
    try {
      const response = await fetch(writeGrantEndpoint, { method: 'POST' })
      if (!response.ok) throw new Error('start failed')
      const body = (await response.json()) as { url?: string }
      if (!body.url) throw new Error('no redirect')
      window.location.assign(body.url)
    } catch {
      setPhase({ kind: 'failed', reason: 'grant' })
    }
  }

  async function loadBlogs() {
    try {
      const response = await fetch(blogsEndpoint)
      if (!response.ok) throw new Error('blogs unavailable')
      const body = (await response.json()) as { blogs: readonly ShopifyBlog[] }
      setBlogs(body.blogs)
    } catch {
      setPhase({ kind: 'failed', reason: 'blog' })
    }
  }

  async function chooseBlog(input: { blogId: string } | { createNamed: string }) {
    try {
      const response = await fetch(selectBlogEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!response.ok) throw new Error('select failed')
      // The blog is resolved now; retry turning delivery on.
      await setDelivery('auto')
    } catch {
      setPhase({ kind: 'failed', reason: 'blog' })
    }
  }

  return (
    <section className="sortiva-settings__panel" data-settings-section="publishing">
      <h1>{t('settings.publishing.heading')}</h1>

      <div className="sortiva-settings__row" data-setting="delivery_mode">
        <div>
          <h2>{t('settings.publishing.delivery.heading')}</h2>
          <p className="sortiva-settings__note">{t('settings.publishing.delivery.exportNote')}</p>
        </div>
        <div role="group" aria-label={t('settings.publishing.delivery.heading')}>
          <button
            type="button"
            aria-pressed={settings.delivery === 'export'}
            onClick={() => void setDelivery('export')}
          >
            {t('settings.publishing.delivery.export')}
          </button>
          <button
            type="button"
            aria-pressed={settings.delivery === 'auto'}
            disabled={phase.kind === 'saving' || phase.kind === 'granting'}
            onClick={() => void setDelivery('auto')}
          >
            {t('settings.publishing.delivery.auto')}
          </button>
        </div>
      </div>

      {phase.kind === 'grant_needed' || phase.kind === 'granting' ? (
        <div className="sortiva-settings__inline-card" data-setting="write_grant">
          <h2>{t('settings.publishing.writeGrant.heading')}</h2>
          <p>{t('settings.publishing.writeGrant.body')}</p>
          <button type="button" disabled={phase.kind === 'granting'} onClick={() => void requestWriteGrant()}>
            {t('settings.publishing.writeGrant.button')}
          </button>
        </div>
      ) : null}

      {phase.kind === 'blog_picker' ? (
        <BlogPicker
          t={t}
          blogs={blogs}
          newBlogName={newBlogName}
          onNewBlogNameChange={setNewBlogName}
          onLoad={loadBlogs}
          onSelect={(blogId) => void chooseBlog({ blogId })}
          onCreate={() => {
            const name = newBlogName.trim()
            if (name.length === 0) return
            void chooseBlog({ createNamed: name })
          }}
        />
      ) : null}

      {phase.kind === 'failed' ? (
        <p className="sortiva-settings__error" role="alert">
          {phase.reason === 'grant'
            ? t('settings.publishing.writeGrant.failed')
            : t('settings.publishing.blogPicker.failed')}
        </p>
      ) : null}

      {showsTargetBlog(settings) && phase.kind === 'idle' ? (
        <div className="sortiva-settings__row" data-setting="target_blog">
          <div>
            <h2>{t('settings.publishing.targetBlog.heading')}</h2>
            <p className="sortiva-settings__note">{t('settings.publishing.targetBlog.note')}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setPhase({ kind: 'blog_picker' })
              void loadBlogs()
            }}
          >
            {t('settings.publishing.targetBlog.change')}
          </button>
        </div>
      ) : null}

      <div className="sortiva-settings__row" data-setting="publish_as">
        <h2>{t('settings.publishing.publishAs.heading')}</h2>
        <select
          value={settings.shopifyPublishAs}
          onChange={(event) => void save({ shopifyPublishAs: event.target.value as PublishAs })}
        >
          <option value="live">{t('settings.publishing.publishAs.live')}</option>
          <option value="draft">{t('settings.publishing.publishAs.draft')}</option>
        </select>
      </div>

      <div className="sortiva-settings__row" data-setting="publish_hour_timezone">
        <h2>{t('settings.publishing.publishHour.heading')}</h2>
        <select
          aria-label={t('settings.publishing.publishHour.heading')}
          value={settings.publishHour}
          onChange={(event) => void save({ publishHour: Number(event.target.value) })}
        >
          {PUBLISH_HOURS.map((hour) => (
            <option key={hour} value={hour}>
              {formatHour(hour)}
            </option>
          ))}
        </select>

        <label>
          {t('settings.publishing.timezone.heading')}
          <select
            aria-label={t('settings.publishing.timezone.heading')}
            value={zones.all.includes(settings.timezone) ? settings.timezone : zones.suggested}
            onChange={(event) => void save({ timezone: event.target.value })}
          >
            {zones.all.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
        <p className="sortiva-settings__note">{t('settings.publishing.timezone.note')}</p>
      </div>

      <div className="sortiva-settings__row" data-setting="draft_review">
        <div>
          <h2>{t('settings.publishing.draftReview.heading')}</h2>
          <p className="sortiva-settings__note">{t('settings.publishing.draftReview.explain')}</p>
        </div>
        <input
          type="checkbox"
          role="switch"
          checked={settings.draftReview}
          onChange={(event) => void save({ draftReview: event.target.checked })}
        />
      </div>

      {showsAutoRepair(settings) ? (
        <div className="sortiva-settings__row" data-setting="auto_repair">
          <div>
            <h2>{t('settings.publishing.autoRepair.heading')}</h2>
            <p className="sortiva-settings__note">{t('settings.publishing.autoRepair.explain')}</p>
          </div>
          <input
            type="checkbox"
            role="switch"
            checked={settings.autoRepair}
            onChange={(event) => void save({ autoRepair: event.target.checked })}
          />
        </div>
      ) : null}

      <p className="sortiva-settings__info" data-setting="optimize_info">
        {t('settings.publishing.optimizeInfo')}
      </p>

      {savedNote ? (
        <p className="sortiva-settings__saved" role="status">
          {savedNote}
        </p>
      ) : null}
    </section>
  )
}

interface BlogPickerProps {
  readonly t: Translate
  readonly blogs: readonly ShopifyBlog[]
  readonly newBlogName: string
  readonly onNewBlogNameChange: (value: string) => void
  readonly onLoad: () => void
  readonly onSelect: (blogId: string) => void
  readonly onCreate: () => void
}

function BlogPicker({
  t,
  blogs,
  newBlogName,
  onNewBlogNameChange,
  onLoad,
  onSelect,
  onCreate,
}: BlogPickerProps) {
  // Loaded once, when the picker first appears — reopening it after a failed
  // create should not refetch the whole list from under the merchant, so
  // `onLoad` is deliberately not in the dependency list.
  useEffect(() => {
    onLoad()
  }, [])

  return (
    <div className="sortiva-settings__inline-card" data-setting="blog_picker">
      <h2>{t('settings.publishing.blogPicker.heading')}</h2>
      <p>{t('settings.publishing.blogPicker.note')}</p>
      <ul>
        {blogs.map((blog) => (
          <li key={blog.id}>
            <span>{blog.title}</span>
            <button type="button" onClick={() => onSelect(blog.id)}>
              {t('settings.publishing.blogPicker.select')}
            </button>
          </li>
        ))}
      </ul>
      <label htmlFor="sortiva-new-blog">{t('settings.publishing.blogPicker.createLabel')}</label>
      <input
        id="sortiva-new-blog"
        value={newBlogName}
        placeholder={t('settings.publishing.blogPicker.createPlaceholder')}
        onChange={(event) => onNewBlogNameChange(event.target.value)}
      />
      <button type="button" onClick={onCreate}>
        {t('settings.publishing.blogPicker.createButton')}
      </button>
    </div>
  )
}
