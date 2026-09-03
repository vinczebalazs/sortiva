// A narrow, browser-safe import rather than the `@sortiva/core` barrel — see
// the note in `../shell/notifications.ts` for why the barrel cannot be
// imported from a client component.
import { timezoneForCountry } from '@sortiva/core/persona/timezones'
import type { StringKey } from '../strings'
import type { AccountSettingsData, SubscriptionStatus } from './types'

/**
 * The Settings screens' own arithmetic, kept out of the components so it can
 * be tested by describing a state rather than by driving a browser through
 * four sub-screens.
 */

// ── The settings map ─────────────────────────────────────────────────────────

export type SettingsSection = 'publishing' | 'profile' | 'connections' | 'account'

/**
 * Every control ui §9 names, one row each. The section says exactly this:
 * "every setting maps to `account_settings` or an existing spec surface —
 * this list is exhaustive; if a control isn't here, it doesn't exist."
 *
 * Each screen renders exactly this set — one `data-setting="<id>"` element per
 * row — so a control that quietly grew an extra toggle, or lost one, shows up
 * as a mismatch here rather than as something only a designer would notice.
 */
export interface SettingsControl {
  readonly id: string
  readonly section: SettingsSection
  /** What ui §9 calls it, so the inventory can be checked by eye against the spec. */
  readonly label: string
}

export const SETTINGS_CONTROLS: readonly SettingsControl[] = [
  // §9.1 Publishing
  { id: 'delivery_mode', section: 'publishing', label: 'Delivery mode: Export / Auto-publish' },
  { id: 'target_blog', section: 'publishing', label: 'Target blog' },
  { id: 'publish_as', section: 'publishing', label: 'Publish as: Live / Shopify draft' },
  { id: 'publish_hour_timezone', section: 'publishing', label: 'Publish hour + timezone' },
  { id: 'draft_review', section: 'publishing', label: 'Draft review toggle' },
  { id: 'auto_repair', section: 'publishing', label: 'Auto-repair toggle' },
  { id: 'optimize_info', section: 'publishing', label: 'Optimize recommendations info line' },
  // §9.2 Store profile
  { id: 'store_profile', section: 'profile', label: 'The confirmation screen, permanently editable' },
  // §9.3 Connections
  { id: 'shopify_connection', section: 'connections', label: 'Shopify status + reconnect' },
  { id: 'gsc_connection', section: 'connections', label: 'Search Console connect/reconnect/disconnect' },
  // §9.4 Account
  { id: 'vacation_mode', section: 'account', label: 'Vacation mode toggle' },
  { id: 'billing', section: 'account', label: 'Billing: plan card, Manage billing, cancellation facts' },
  { id: 'email_preferences', section: 'account', label: 'Email preferences (opt-in rows of §10)' },
  { id: 'ui_language', section: 'account', label: 'UI language dropdown' },
  { id: 'delete_account', section: 'account', label: 'Delete account: danger zone, type-to-confirm' },
]

export function controlsFor(section: SettingsSection): readonly SettingsControl[] {
  return SETTINGS_CONTROLS.filter((control) => control.section === section)
}

// ── Publish hour ─────────────────────────────────────────────────────────────

/** Every hour a day has, for the publish-hour select. */
export const PUBLISH_HOURS: readonly number[] = Array.from({ length: 24 }, (_, hour) => hour)

export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

// ── Timezone ──────────────────────────────────────────────────────────────────

/**
 * The zones offered in the timezone picker, and which one to show pre-picked.
 *
 * ui §9.1 asks for "an IANA picker pre-filtered to the persona country's
 * zones, override allowed". `packages/core`'s country table names only one
 * default zone per country (the one onboarding wrote), not the set of zones a
 * multi-zone country actually spans, so there is no per-country *list* to
 * filter down to here — building one is a data-modelling task belonging to
 * that table, not this screen. The picker instead pre-selects the country's
 * default and offers every IANA zone as the override, which satisfies both
 * halves of the sentence without inventing geography data this card was not
 * asked to build. Recorded in `DECISIONS.md` 2026-09-03 T9.7.
 */
export interface TimezoneOptions {
  /** The zone to show selected before the merchant touches anything. */
  readonly suggested: string
  /** Every IANA zone name, for the "pick a different one" override. */
  readonly all: readonly string[]
}

/** Every zone the runtime knows, falling back to a short list where `Intl` cannot answer. */
function allTimezones(): readonly string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf
  if (typeof supported === 'function') {
    try {
      return supported('timeZone')
    } catch {
      // Falls through to the fixed list below.
    }
  }
  return ['UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'Asia/Tokyo']
}

export function timezoneOptions(country: string | null | undefined): TimezoneOptions {
  const { timezone } = timezoneForCountry(country)
  const all = allTimezones()
  return {
    suggested: timezone,
    all: all.includes(timezone) ? all : [timezone, ...all],
  }
}

// ── Auto-publish: the write-grant → blog-picker flow ────────────────────────

/**
 * Where turning auto-publish on has got to. Modelled as its own reducer
 * because the flow crosses two conflict codes and a redirect to Shopify and
 * back, and that shape is worth testing without a DOM.
 */
export type WriteGrantPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'grant_needed' }
  | { readonly kind: 'granting' }
  | { readonly kind: 'blog_picker' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'failed'; readonly reason: 'grant' | 'blog' | 'save' }

/** What `PATCH /api/settings { delivery: 'auto' }` answering 409 means for the flow. */
export function phaseAfterDeliveryConflict(code: string | null): WriteGrantPhase {
  if (code === 'write_scope_required') return { kind: 'grant_needed' }
  if (code === 'target_blog_unresolved') return { kind: 'blog_picker' }
  return { kind: 'failed', reason: 'save' }
}

// ── Billing card ──────────────────────────────────────────────────────────────

const BILLING_STATUS_KEYS: Readonly<Record<SubscriptionStatus, StringKey>> = {
  active: 'settings.account.billing.status.active',
  past_due: 'settings.account.billing.status.past_due',
  canceled: 'settings.account.billing.status.canceled',
  incomplete: 'settings.account.billing.status.incomplete',
  incomplete_expired: 'settings.account.billing.status.incomplete_expired',
  none: 'settings.account.billing.status.none',
}

export function billingStatusKey(status: SubscriptionStatus): StringKey {
  return BILLING_STATUS_KEYS[status]
}

// ── Delivery-dependent visibility ────────────────────────────────────────────

/** Target blog and its "change" control show only once auto-publish is on (ui §9.1). */
export function showsTargetBlog(settings: Pick<AccountSettingsData, 'delivery'>): boolean {
  return settings.delivery === 'auto'
}

/** Auto-repair is offered to auto-publish accounts only (ui §9.1; main §14.1). */
export function showsAutoRepair(settings: Pick<AccountSettingsData, 'delivery'>): boolean {
  return settings.delivery === 'auto'
}
