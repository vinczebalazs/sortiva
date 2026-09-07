import { autoPublishReadiness, defaultNotificationPreferences } from '@sortiva/core'
import type { SettingsStore } from '@sortiva/db'
import { t } from '@sortiva/ui/strings/translate'
import type { AccountContext, AccountHandler } from '../../auth/_lib/session'

/**
 * Everything the two Settings screens read and change.
 *
 * One address rather than one per control: a merchant opening Settings wants a
 * screen, not nine requests, and a screen that saves a whole form wants one
 * write that either happens or does not.
 *
 * The exception is switching on auto-publish, which is the one setting with a
 * condition attached and is handled below rather than written straight through.
 */

export interface SettingsDeps {
  readonly store: SettingsStore
  readonly now?: () => Date
}

const CODES = {
  writeScopeRequired: 'write_scope_required',
  targetBlogUnresolved: 'target_blog_unresolved',
  invalid: 'settings_invalid',
} as const

/** The envelope every other route answers a refusal in, and the one the screens read. */
function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}

/** The shape the frozen contract promises, assembled from the two tables that hold it. */
async function currentSettings(deps: SettingsDeps, context: AccountContext) {
  const [settings, stored] = await Promise.all([
    deps.store.read(context.scope),
    deps.store.emailPrefs(context.scope),
  ])
  const prefs = stored ?? defaultNotificationPreferences()
  return {
    delivery: settings.delivery,
    shopifyPublishAs: settings.shopifyPublishAs,
    publishHour: settings.publishHour,
    timezone: settings.timezone,
    draftReview: settings.draftReview,
    autoRepair: settings.autoRepair,
    vacationMode: settings.vacationMode,
    uiLanguage: settings.uiLanguage,
    emailArticlePublished: prefs.emailArticlePublished,
    emailDigestFrequency: prefs.emailDigestFrequency,
  }
}

export function makeReadSettingsHandler(deps: SettingsDeps): AccountHandler {
  return async (_request, context: AccountContext) =>
    Response.json(await currentSettings(deps, context))
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour)
const DIGESTS = ['off', 'daily', 'weekly']

/**
 * Applies what the merchant changed, and answers with the settings as they now
 * stand rather than with an acknowledgement — so a screen that half-succeeded
 * shows what is actually true instead of what it hoped for.
 */
export function makeUpdateSettingsHandler(deps: SettingsDeps): AccountHandler {
  return async (request, context: AccountContext) => {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (body === null || typeof body !== 'object') {
      return error(422, CODES.invalid, t('settings.errors.invalid'))
    }

    const patch: Record<string, unknown> = {}
    const bad = (field: string): Response =>
      error(422, CODES.invalid, t('settings.errors.fieldInvalid', { field }))

    if ('publishHour' in body) {
      if (!HOURS.includes(body.publishHour as number)) return bad('publishHour')
      patch.publishHour = body.publishHour
    }
    if ('timezone' in body) {
      if (typeof body.timezone !== 'string' || body.timezone === '') return bad('timezone')
      patch.timezone = body.timezone
    }
    if ('shopifyPublishAs' in body) {
      if (body.shopifyPublishAs !== 'live' && body.shopifyPublishAs !== 'draft') {
        return bad('shopifyPublishAs')
      }
      patch.shopifyPublishAs = body.shopifyPublishAs
    }
    for (const flag of ['draftReview', 'autoRepair', 'vacationMode'] as const) {
      if (flag in body) {
        if (typeof body[flag] !== 'boolean') return bad(flag)
        patch[flag] = body[flag]
      }
    }
    if ('uiLanguage' in body) {
      if (body.uiLanguage !== null && typeof body.uiLanguage !== 'string') return bad('uiLanguage')
      patch.uiLanguage = body.uiLanguage
    }

    // Switching *on* is the guarded direction. Switching off is not: a merchant
    // withdrawing permission to post must never be held up by the state of the
    // permission they are withdrawing.
    if (body.delivery === 'auto') {
      const target = await deps.store.publishTarget(context.scope)
      const readiness = autoPublishReadiness({
        grantedScopes: target?.grantedScopes ?? [],
        targetBlogId: target?.targetBlogId ?? null,
      })
      if (!readiness.ok) {
        return error(
          409,
          readiness.code,
          readiness.code === CODES.writeScopeRequired
            ? t('settings.publishing.errors.writeScopeRequired')
            : t('settings.publishing.errors.targetBlogUnresolved'),
        )
      }
    } else if ('delivery' in body && body.delivery !== 'export') {
      return bad('delivery')
    }

    await deps.store.save(context.scope, patch, deps.now?.())

    if (body.delivery === 'auto' || body.delivery === 'export') {
      // The same two conditions again, as a `WHERE` clause, and the reason this
      // does not write `delivery` itself: a caller that passed the check above
      // on a stale read of the connection still cannot turn it on.
      const switched = await deps.store.setDelivery(context.scope, body.delivery)
      if (!switched) {
        return error(
          409,
          CODES.targetBlogUnresolved,
          t('settings.publishing.errors.targetBlogUnresolved'),
        )
      }
    }

    const emails: { emailArticlePublished?: boolean; emailDigestFrequency?: 'off' | 'daily' | 'weekly' } = {}
    if ('emailArticlePublished' in body) {
      if (typeof body.emailArticlePublished !== 'boolean') return bad('emailArticlePublished')
      emails.emailArticlePublished = body.emailArticlePublished
    }
    if ('emailDigestFrequency' in body) {
      if (!DIGESTS.includes(body.emailDigestFrequency as string)) return bad('emailDigestFrequency')
      emails.emailDigestFrequency = body.emailDigestFrequency as 'off' | 'daily' | 'weekly'
    }
    if (Object.keys(emails).length > 0) {
      // Both columns, always: a partial write would take the other one's
      // database default and switch off something the merchant never touched.
      const current = (await deps.store.emailPrefs(context.scope)) ?? {
        ...defaultNotificationPreferences(),
      }
      await deps.store.saveEmailPrefs(context.scope, {
        emailArticlePublished: current.emailArticlePublished,
        emailDigestFrequency: current.emailDigestFrequency,
        ...emails,
      })
    }

    return Response.json(await currentSettings(deps, context))
  }
}
