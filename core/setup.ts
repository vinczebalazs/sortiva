import type { Db } from '../db/pool.ts'
import type { Language } from './config.ts'
import { syncProgress } from './learn/sync.ts'
import { languageFromLocale } from './learn/profile.ts'

export type SetupStep = 'reading' | 'no_products' | 'profile' | 'search_console' | 'delivery' | 'done'

export type SetupState = {
  step: SetupStep
  shopDomain: string
  /** False when the store's own language is neither English nor Hungarian; the merchant picks one. */
  storeLanguageSupported: boolean
  reading: {
    products: { done: number; total: number; complete: boolean }
    facts: { done: number; total: number; complete: boolean }
    profile: { complete: boolean }
  }
  profile: { sells: string; audience: string; language: Language; country: string; tone: 'plain' | 'friendly' | 'expert'; neverSay: string } | null
}

export async function setupState(db: Db, storeId: number): Promise<SetupState> {
  const { rows } = await db.query<{
    setup_step: SetupStep
    shop_domain: string
    primary_locale: string | null
    products: number
    sells: string | null
    audience: string | null
    language: Language | null
    country: string | null
    tone: 'plain' | 'friendly' | 'expert' | null
    never_say: string | null
  }>(
    `select s.setup_step, s.shop_domain, s.primary_locale,
            (select count(*)::int from products where store_id = s.id and deleted_at is null) as products,
            p.sells, p.audience, p.language, p.country, p.tone, p.never_say
     from stores s left join store_profile p on p.store_id = s.id where s.id = $1`,
    [storeId],
  )
  const row = rows[0]!
  const progress = await syncProgress(db, storeId)
  const reading = row.setup_step === 'reading'
  const productsDone = !reading || (progress.running && progress.phase === 'facts')
  return {
    step: row.setup_step,
    shopDomain: row.shop_domain,
    storeLanguageSupported: languageFromLocale(row.primary_locale) !== null,
    reading: {
      products: {
        done: progress.running && progress.phase === 'products' ? progress.done : row.products,
        total: progress.running && progress.phase === 'products' ? progress.total : row.products,
        complete: productsDone,
      },
      facts: {
        done: progress.running && progress.phase === 'facts' ? progress.done : 0,
        total: progress.running && progress.phase === 'facts' ? progress.total : 0,
        complete: !reading,
      },
      profile: { complete: row.sells !== null },
    },
    profile: row.sells
      ? { sells: row.sells, audience: row.audience!, language: row.language!, country: row.country!, tone: row.tone!, neverSay: row.never_say ?? '' }
      : null,
  }
}

export type ProfileInput = { sells: string; audience: string; language: string; country: string; tone: string; neverSay: string }

export type ProfileErrors = Partial<Record<keyof ProfileInput, 'required' | 'unsupported'>>

/** The merchant's confirmation; nothing is written for a store before this. */
export async function confirmProfile(db: Db, storeId: number, input: ProfileInput): Promise<{ ok: true } | { ok: false; errors: ProfileErrors }> {
  const errors: ProfileErrors = {}
  if (!input.sells?.trim()) errors.sells = 'required'
  if (!input.audience?.trim()) errors.audience = 'required'
  if (input.language !== 'en' && input.language !== 'hu') errors.language = 'unsupported'
  if (!input.country?.trim()) errors.country = 'required'
  if (!['plain', 'friendly', 'expert'].includes(input.tone)) errors.tone = 'required'
  if (Object.keys(errors).length) return { ok: false, errors }

  await db.query(
    `insert into store_profile (store_id, sells, audience, language, country, tone, never_say, confirmed_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (store_id) do update set sells = excluded.sells, audience = excluded.audience, language = excluded.language,
       country = excluded.country, tone = excluded.tone, never_say = excluded.never_say, confirmed_at = now()`,
    [storeId, input.sells.trim(), input.audience.trim(), input.language, input.country.trim().toUpperCase(), input.tone, input.neverSay?.trim() ?? ''],
  )
  await db.query(`update stores set setup_step = 'search_console' where id = $1 and setup_step = 'profile'`, [storeId])
  return { ok: true }
}
