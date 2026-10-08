import type { Db } from '../db/pool.ts'
import { confirmProfile, type ProfileErrors, type ProfileInput } from './setup.ts'
import { pauseReason, type PauseReason } from './status.ts'

export type DeliveryInput = {
  mode: string
  /** An existing blog's id, or "create" for a new blog called `newBlogTitle`. */
  blog: string | null
  newBlogTitle?: string
  publishAs: string
  publishHour: number
  reviewFirst: boolean
}

export type DeliveryErrors = Partial<Record<'mode' | 'blog' | 'publishAs' | 'publishHour', 'required' | 'invalid'>>

export type SettingsState = {
  delivery: { mode: 'export' | 'auto_publish'; blogId: string | null; blogToCreate: string | null; publishAs: 'live' | 'draft'; publishHour: number; reviewFirst: boolean }
  blogs: { id: string; title: string }[]
  timezone: string
  pausedByMerchant: boolean
  /** A pause we put on ourselves, if any, shown under the merchant's switch. */
  pausedByUs: Exclude<PauseReason, 'paused_by_merchant'> | null
  searchConsole: { connected: boolean; property: string | null; since: string | null }
}

export async function settingsState(db: Db, storeId: number): Promise<SettingsState> {
  const { rows } = await db.query<{
    delivery_mode: 'export' | 'auto_publish'
    target_blog_id: string | null
    blog_to_create: string | null
    publish_as: 'live' | 'draft'
    publish_hour: number
    review_first: boolean
    timezone: string
    paused_by_merchant: boolean
    property: string | null
    connected_at: Date | null
    disconnected_at: Date | null
  }>(
    `select s.delivery_mode, s.target_blog_id, s.blog_to_create, s.publish_as, s.publish_hour, s.review_first, s.timezone,
            f.paused_by_merchant, g.property, g.connected_at, g.disconnected_at
     from stores s join store_flags f on f.store_id = s.id left join gsc_connections g on g.store_id = s.id where s.id = $1`,
    [storeId],
  )
  const r = rows[0]!
  const { rows: blogs } = await db.query<{ id: string; title: string }>(
    `select platform_id as id, title from store_pages where store_id = $1 and kind = 'blog' order by title`,
    [storeId],
  )
  const connected = Boolean(r.connected_at && !r.disconnected_at)
  const ours = await pauseReason(db, storeId)
  return {
    delivery: { mode: r.delivery_mode, blogId: r.target_blog_id, blogToCreate: r.blog_to_create, publishAs: r.publish_as, publishHour: r.publish_hour, reviewFirst: r.review_first },
    blogs,
    timezone: r.timezone,
    pausedByMerchant: r.paused_by_merchant,
    pausedByUs: ours === 'paused_by_merchant' ? null : ours,
    searchConsole: { connected, property: connected ? r.property : null, since: connected ? r.connected_at!.toISOString() : null },
  }
}

/** Setup step 4 and the Settings "Publishing" section. Auto-publish is refused until a blog is chosen. */
export async function saveDelivery(db: Db, storeId: number, input: DeliveryInput): Promise<{ ok: true } | { ok: false; errors: DeliveryErrors }> {
  const errors: DeliveryErrors = {}
  if (input.mode !== 'export' && input.mode !== 'auto_publish') errors.mode = 'invalid'
  if (input.publishAs !== 'live' && input.publishAs !== 'draft') errors.publishAs = 'invalid'
  if (!Number.isInteger(input.publishHour) || input.publishHour < 0 || input.publishHour > 23) errors.publishHour = 'invalid'
  let blogId: string | null = null
  let blogToCreate: string | null = null
  if (input.mode === 'auto_publish') {
    if (input.blog === 'create') blogToCreate = input.newBlogTitle?.trim() || 'Blog'
    else if (input.blog) {
      const { rowCount } = await db.query(`select 1 from store_pages where store_id = $1 and kind = 'blog' and platform_id = $2`, [storeId, input.blog])
      if (rowCount) blogId = input.blog
      else errors.blog = 'invalid'
    } else errors.blog = 'required'
  }
  if (Object.keys(errors).length) return { ok: false, errors }

  // Switching to export keeps the chosen blog, so switching back needs no new choice; nothing already published is touched.
  await db.query(
    `update stores set delivery_mode = $2, publish_as = $3, publish_hour = $4, review_first = $5,
       target_blog_id = case when $2 = 'auto_publish' then $6 else target_blog_id end,
       blog_to_create = case when $2 = 'auto_publish' then $7 else blog_to_create end
     where id = $1`,
    [storeId, input.mode, input.publishAs, input.publishHour, input.reviewFirst, blogId, blogToCreate],
  )
  return { ok: true }
}

/** Setup step 3, "Skip for now": the store runs in Limited mode until Search Console is connected. */
export async function skipSearchConsole(db: Db, storeId: number): Promise<void> {
  await db.query(`update stores set setup_step = 'delivery' where id = $1 and setup_step = 'search_console'`, [storeId])
}

/** Setup step 4, "Finish setup". Returns true the first time, when topic-finding should start. */
export async function finishSetup(db: Db, storeId: number, input: DeliveryInput): Promise<{ ok: true; first: boolean } | { ok: false; errors: DeliveryErrors }> {
  const saved = await saveDelivery(db, storeId, input)
  if (!saved.ok) return saved
  const { rowCount } = await db.query(`update stores set setup_step = 'done' where id = $1 and setup_step = 'delivery'`, [storeId])
  return { ok: true, first: Boolean(rowCount) }
}

/** The Settings profile section. A change after setup sends topic-finding out again. */
export async function updateProfile(db: Db, storeId: number, input: ProfileInput): Promise<{ ok: true; changed: boolean } | { ok: false; errors: ProfileErrors }> {
  const before = await db.query(`select sells, audience, language, country, tone, never_say from store_profile where store_id = $1`, [storeId])
  const result = await confirmProfile(db, storeId, input)
  if (!result.ok) return result
  const after = await db.query(`select sells, audience, language, country, tone, never_say from store_profile where store_id = $1`, [storeId])
  // A new language applies to topics not yet written: waiting ones in the old language leave the queue.
  await db.query(`update topics set state = 'candidate', manual_position = null where store_id = $1 and state = 'queued' and language <> $2`, [storeId, after.rows[0].language])
  return { ok: true, changed: JSON.stringify(before.rows[0]) !== JSON.stringify(after.rows[0]) }
}

export async function setMerchantPause(db: Db, storeId: number, paused: boolean): Promise<void> {
  await db.query(`update store_flags set paused_by_merchant = $2 where store_id = $1`, [storeId, paused])
}
