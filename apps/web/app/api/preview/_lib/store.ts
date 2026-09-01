import { and, eq, sql } from 'drizzle-orm'
import type { PreviewCacheEntry, PreviewCacheStore, PreviewKillSwitch } from '@sortiva/core'
import { PREVIEW_PAUSED_FLAG } from '@sortiva/core'
import { isGlobalFlagActive, previewCache, systemScope, type Db } from '@sortiva/db'

/**
 * The Postgres side of the preview: its 7-day cache and the kill switch that
 * pauses it.
 *
 * **Where this ought to live.** `packages/db/src/repositories/system.ts` already
 * owns `readPreviewCache`; the matching writer belongs beside it. It is here
 * because T1.3 was told not to edit `packages/db` while other sessions hold it,
 * and no migration was permitted. Move both methods into that repository at the
 * next integration pass — see DECISIONS 2026-09-01 T1.3. The `SystemScope` and
 * the table definition are still the shared ones, so the move is a cut and
 * paste rather than a rewrite.
 *
 * The scope is a system scope because a preview happens before an account
 * exists (main §3): there is no `account_id` to scope by, and `preview_cache`
 * is keyed by domain for exactly that reason.
 */

const SCOPE = systemScope('preview_cache has no account: a preview happens pre-signup (main §3)')

/** What `preview_cache.summary` (jsonb) holds. main §3.3 step 6: `{domain, summary, fetched_at}`. */
interface StoredPreviewSummary {
  readonly summary: string
}

export class PostgresPreviewCache implements PreviewCacheStore {
  constructor(private readonly db: Db) {}

  async read(domain: string): Promise<PreviewCacheEntry | undefined> {
    const [row] = await this.db
      .select()
      .from(previewCache)
      .where(
        and(eq(previewCache.domainNormalized, domain), sql`${previewCache.expiresAt} > now()`),
      )
      .limit(1)
    if (!row) return undefined
    const stored = row.summary as StoredPreviewSummary
    if (typeof stored?.summary !== 'string') return undefined
    return { domain: row.domainNormalized, summary: stored.summary, fetchedAt: row.fetchedAt }
  }

  async write(entry: PreviewCacheEntry & { expiresAt: Date }): Promise<void> {
    const stored: StoredPreviewSummary = { summary: entry.summary }
    await this.db
      .insert(previewCache)
      .values({
        domainNormalized: entry.domain,
        summary: stored,
        fetchedAt: entry.fetchedAt,
        expiresAt: entry.expiresAt,
      })
      // A second visitor previewing the same site while the first was in flight
      // refreshes the row rather than colliding on the primary key.
      .onConflictDoUpdate({
        target: previewCache.domainNormalized,
        set: { summary: stored, fetchedAt: entry.fetchedAt, expiresAt: entry.expiresAt },
      })
  }
}

/**
 * main §14.5, invariant 17 — "Daily preview LLM spend > its own cap → pause the
 * preview endpoint only". Read from `ops_flags`, our own table: PostHog
 * displays cost, our code enforces caps.
 *
 * Only the *reading* side is here. The job that compares the day's preview
 * spend against `auto_trips.preview_spend.global_cap_usd_per_day` and raises the
 * flag is the cost-ledger card (R2), which owns the spend counter; T1.3 does not
 * invent a second one. See DECISIONS 2026-09-01 T1.3.
 */
export class OpsFlagPreviewSwitch implements PreviewKillSwitch {
  constructor(private readonly db: Db) {}

  async isPreviewPaused(): Promise<boolean> {
    return isGlobalFlagActive(this.db, SCOPE, PREVIEW_PAUSED_FLAG)
  }
}
