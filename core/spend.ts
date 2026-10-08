import type { DbClient } from '../db/pool.ts'
import { CONFIG } from './config.ts'
import { BudgetExceededError } from './errors.ts'

// Pending rows count too: a call that crashed mid-flight may still have been billed.
const SPENT_TODAY = `
  select coalesce(sum(coalesce(cost_usd, estimated_cost_usd)), 0)::float8 as usd from (
    select store_id, cost_usd, estimated_cost_usd, created_at from llm_calls
    union all
    select store_id, cost_usd, estimated_cost_usd, created_at from vendor_calls
  ) calls
  where created_at >= date_trunc('day', now()) and status_filter`

export async function spentToday(db: DbClient, storeId: number | null): Promise<number> {
  const sql = SPENT_TODAY.replace('status_filter', storeId === null ? 'true' : 'store_id = $1')
  const { rows } = await db.query<{ usd: number }>(sql, storeId === null ? [] : [storeId])
  return rows[0]!.usd
}

/** Throws before money is spent if this call would push the store or everyone past today's cap. */
export async function assertWithinBudget(db: DbClient, storeId: number | null, estimateUsd: number): Promise<void> {
  if (storeId !== null && (await spentToday(db, storeId)) + estimateUsd > CONFIG.spendCapUsd.perStoreDaily) {
    throw new BudgetExceededError('store', storeId)
  }
  if ((await spentToday(db, null)) + estimateUsd > CONFIG.spendCapUsd.globalDaily) {
    throw new BudgetExceededError('global', storeId)
  }
}
