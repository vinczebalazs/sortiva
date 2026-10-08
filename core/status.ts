import type { DbClient } from '../db/pool.ts'
import { CONFIG } from './config.ts'

/** Work stopped on purpose. The job ends without retrying and without recording a result. */
export class StorePausedError extends Error {
  constructor(readonly storeId: number, readonly reason: 'permission' | 'access' | 'budget' | 'merchant' | 'operator' | 'not_entitled' | 'closed') {
    super(`store ${storeId} paused: ${reason}`)
  }
}

const LOCAL_TODAY = `(now() at time zone (select timezone from stores where id = $1))::date`

export async function recordPermissionLost(db: DbClient, storeId: number, scope: string): Promise<void> {
  await db.query(
    `update store_flags set permissions_lost = array(select distinct unnest(permissions_lost || $2::text)) where store_id = $1`,
    [storeId, scope],
  )
}

export async function clearPermissionsLost(db: DbClient, storeId: number, scopes: string[]): Promise<void> {
  await db.query(
    `update store_flags set permissions_lost = array(select unnest(permissions_lost) except select unnest($2::text[])) where store_id = $1`,
    [storeId, scopes],
  )
}

export async function recordBudgetPause(db: DbClient, storeId: number): Promise<void> {
  await db.query(`update store_flags set budget_paused_on = ${LOCAL_TODAY} where store_id = $1`, [storeId])
}

export type Banner =
  | { kind: 'paused_by_merchant' }
  | { kind: 'budget_reached' }
  | { kind: 'permission_lost'; scopes: string[] }
  | { kind: 'no_blog' }
  | { kind: 'gsc_disconnected' }
  | { kind: 'not_entitled' }

/** Conditions that stop work, each a banner on every screen while it holds. */
export async function banners(db: DbClient, storeId: number): Promise<Banner[]> {
  const { rows } = await db.query<{
    paused_by_merchant: boolean
    entitled: boolean
    budget_today: boolean
    permissions_lost: string[]
    no_blog: boolean
    gsc_disconnected: boolean
  }>(
    `select f.paused_by_merchant, f.entitled, coalesce(f.budget_paused_on = ${LOCAL_TODAY}, false) as budget_today,
            f.permissions_lost, (s.delivery_mode = 'auto_publish' and ((s.target_blog_id is null and s.blog_to_create is null) or f.blog_missing)) as no_blog,
            f.gsc_disconnected
     from store_flags f join stores s on s.id = f.store_id where f.store_id = $1`,
    [storeId],
  )
  const f = rows[0]
  if (!f) return []
  const out: Banner[] = []
  if (!f.entitled) out.push({ kind: 'not_entitled' })
  if (f.paused_by_merchant) out.push({ kind: 'paused_by_merchant' })
  if (f.budget_today) out.push({ kind: 'budget_reached' })
  if (f.permissions_lost.length) out.push({ kind: 'permission_lost', scopes: f.permissions_lost })
  if (f.no_blog) out.push({ kind: 'no_blog' })
  if (f.gsc_disconnected) out.push({ kind: 'gsc_disconnected' })
  return out
}

export type PauseReason = 'not_entitled' | 'paused_by_operator' | 'paused_by_merchant' | 'budget' | 'permission'

/** Why nothing should be written for this store today, or null when it may go ahead. */
export async function pauseReason(db: DbClient, storeId: number): Promise<PauseReason | null> {
  const { rows } = await db.query<{ entitled: boolean; operator: boolean; merchant: boolean; budget: boolean; permission: boolean }>(
    `select entitled, paused_by_operator as operator, paused_by_merchant as merchant,
            coalesce(budget_paused_on = ${LOCAL_TODAY}, false) as budget, cardinality(permissions_lost) > 0 as permission
     from store_flags where store_id = $1`,
    [storeId],
  )
  const f = rows[0]
  if (!f) return null
  if (!f.entitled) return 'not_entitled'
  if (f.operator) return 'paused_by_operator'
  if (f.merchant) return 'paused_by_merchant'
  if (f.budget) return 'budget'
  if (f.permission) return 'permission'
  return null
}

export type ThinState ={ thin: boolean; usable: number; total: number }

export async function thinState(db: DbClient, storeId: number): Promise<ThinState> {
  const { rows } = await db.query<{ usable: number; total: number }>(
    `select count(*) filter (where richness >= $2)::int as usable, count(*)::int as total
     from products where store_id = $1 and deleted_at is null`,
    [storeId, CONFIG.minFactsPerProduct],
  )
  const { usable, total } = rows[0]!
  return { thin: usable < CONFIG.thinStoreFloor, usable, total }
}
