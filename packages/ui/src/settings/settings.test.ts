import { describe, expect, it } from 'vitest'
import {
  controlsFor,
  formatHour,
  phaseAfterDeliveryConflict,
  PUBLISH_HOURS,
  SETTINGS_CONTROLS,
  showsAutoRepair,
  showsTargetBlog,
  timezoneOptions,
} from './settings'

/**
 * ui §9's own line: "Every setting maps to `account_settings` or an existing
 * spec surface — this list is exhaustive; if a control isn't here, it doesn't
 * exist." Transcribed once here, by hand, from the spec text — a control the
 * screens grow that the spec never asked for, or one the spec asks for that
 * the screens dropped, breaks this test rather than going unnoticed.
 */
const SPEC_CONTROL_IDS = [
  'delivery_mode',
  'target_blog',
  'publish_as',
  'publish_hour_timezone',
  'draft_review',
  'auto_repair',
  'optimize_info',
  'store_profile',
  'shopify_connection',
  'gsc_connection',
  'vacation_mode',
  'billing',
  'email_preferences',
  'ui_language',
  'delete_account',
]

describe('the settings map', () => {
  it('holds exactly the controls ui §9 names, none more and none fewer', () => {
    expect(SETTINGS_CONTROLS.map((control) => control.id).sort()).toEqual(
      [...SPEC_CONTROL_IDS].sort(),
    )
  })

  it('every control has an id used nowhere twice', () => {
    const ids = SETTINGS_CONTROLS.map((control) => control.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('sorts publishing controls under §9.1 and account controls under §9.4', () => {
    expect(controlsFor('publishing').map((c) => c.id)).toContain('delivery_mode')
    expect(controlsFor('account').map((c) => c.id)).toContain('delete_account')
  })
})

describe('publish hour', () => {
  it('offers all 24 hours', () => {
    expect(PUBLISH_HOURS).toHaveLength(24)
    expect(PUBLISH_HOURS[0]).toBe(0)
    expect(PUBLISH_HOURS[23]).toBe(23)
  })

  it('formats as a 24-hour clock', () => {
    expect(formatHour(9)).toBe('09:00')
    expect(formatHour(0)).toBe('00:00')
  })
})

describe('timezone options', () => {
  it('suggests the store country\'s default zone', () => {
    expect(timezoneOptions('DK').suggested).toBe('Europe/Copenhagen')
  })

  it('suggests the multi-zone default for a country spanning several', () => {
    expect(timezoneOptions('US').suggested).toBe('America/New_York')
  })

  it('falls back to UTC for a country with no entry', () => {
    expect(timezoneOptions('XX').suggested).toBe('UTC')
  })

  it('always includes the suggested zone in the full list', () => {
    const { suggested, all } = timezoneOptions('DK')
    expect(all).toContain(suggested)
  })

  it('offers more than one zone to override into', () => {
    expect(timezoneOptions('DK').all.length).toBeGreaterThan(1)
  })
})

describe('turning auto-publish on', () => {
  it('asks for the write grant when Shopify has not granted one', () => {
    expect(phaseAfterDeliveryConflict('write_scope_required')).toEqual({ kind: 'grant_needed' })
  })

  it('opens the blog picker when no target blog is resolved', () => {
    expect(phaseAfterDeliveryConflict('target_blog_unresolved')).toEqual({ kind: 'blog_picker' })
  })

  it('reports a plain failure for anything else', () => {
    expect(phaseAfterDeliveryConflict('something_else')).toEqual({ kind: 'failed', reason: 'save' })
    expect(phaseAfterDeliveryConflict(null)).toEqual({ kind: 'failed', reason: 'save' })
  })
})

describe('delivery-dependent visibility', () => {
  it('shows the target blog only once auto-publish is on', () => {
    expect(showsTargetBlog({ delivery: 'export' })).toBe(false)
    expect(showsTargetBlog({ delivery: 'auto' })).toBe(true)
  })

  it('offers auto-repair only to auto-publish accounts', () => {
    expect(showsAutoRepair({ delivery: 'export' })).toBe(false)
    expect(showsAutoRepair({ delivery: 'auto' })).toBe(true)
  })
})
