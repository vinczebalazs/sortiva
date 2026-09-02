import { sql } from 'drizzle-orm'
import {
  ENRICHMENT_PAUSED_FLAG,
  accountAttribution,
  type SeoDataProvider,
} from '@sortiva/core'
import {
  accountScope,
  isGlobalFlagActive,
  keywordsNeedingEnrichment,
  readPersona,
  systemScope,
  upsertKeywords,
  type Db,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import { runtimeLogger } from '../runtime/logging'
import { registerTask } from '../runtime/tasks'
import { withAccountLock } from '../runtime/lock'
import type { IngestionDeps } from './deps'

/**
 * Pricing a search term the merchant typed in themselves.
 *
 * The confirmation screen is the one place in the product where a vendor lookup
 * is latency-sensitive: a merchant adds a term and wants to see what it is
 * worth. It still does not happen in the request — a slow vendor would become a
 * slow page, and a request that spends money is a request that can spend it
 * twice on a double-click. So the route writes the term unpriced, answers
 * immediately, and asks for this; the screen shows a loading state against that
 * one chip and fills it in when the answer lands.
 *
 * What makes it feel immediate is the queue's own priority, not a shortcut: the
 * job is queued ahead of the nightly sweeps and the catalogue walks that would
 * otherwise be in front of it.
 */

export const KEYWORD_ENRICH_TASK = 'keyword_enrich'

export interface KeywordEnrichPayload {
  readonly accountId: string
  /** The term as stored: trimmed, lower-cased, whitespace collapsed. */
  readonly term: string
}

/**
 * Graphile Worker runs lower numbers first, and everything else in this product
 * is queued at the default of zero. A merchant waiting in front of a form is
 * the only work in the system with a person attached to it.
 */
const HIGH_PRIORITY = -10

export async function enqueueKeywordEnrichment(
  database: Db,
  payload: KeywordEnrichPayload,
): Promise<void> {
  const task = KEYWORD_ENRICH_TASK
  const body = JSON.stringify(payload)
  // Keyed on the account and the term, so a merchant who adds the same term
  // twice — or a retried request — asks one question rather than two.
  const key = `${KEYWORD_ENRICH_TASK}:${payload.accountId}:${payload.term}`
  await database.execute(
    sql`select graphile_worker.add_job(${task}, payload := ${body}::json, job_key := ${key}, priority := ${HIGH_PRIORITY}, job_key_mode := 'preserve_run_at')`,
  )
}

export interface EnrichKeywordResult {
  /** False when the term was already priced inside its lifetime, or the switch is up. */
  readonly priced: boolean
  readonly reason?: 'already_fresh' | 'paused' | 'no_persona' | 'not_found'
}

/**
 * Prices one term, if it still needs pricing.
 *
 * Every reason not to buy is checked here rather than at the point the job was
 * queued, because the queue is at-least-once and the gap between queueing and
 * running is exactly where a term gets priced by something else, a merchant
 * removes it again, or the day's bill crosses its ceiling.
 *
 * The account's advisory lock is taken for the same reason every other piece of
 * that account's work takes it: onboarding's own keyword step may be running,
 * and two writers on one store's keyword rows is how a merchant's hand-typed
 * term gets overwritten by a draft that never knew about it.
 */
export async function enrichKeyword(
  deps: Pick<IngestionDeps, 'db' | 'pool' | 'seo' | 'now'>,
  payload: KeywordEnrichPayload,
): Promise<EnrichKeywordResult> {
  const log = runtimeLogger().child({ account_id: payload.accountId, task: KEYWORD_ENRICH_TASK })
  const system = systemScope('the search-data spend ceiling is global; it has no account')

  if (await isGlobalFlagActive(deps.db, system, ENRICHMENT_PAUSED_FLAG)) {
    log.info('keyword_enrich.paused', { flag: ENRICHMENT_PAUSED_FLAG })
    return { priced: false, reason: 'paused' }
  }

  const seo = deps.seo
  if (!seo) throw new Error('keyword enrichment needs the search-data provider')

  return withAccountLock(deps.pool, payload.accountId, async () => {
    const scope = accountScope(payload.accountId)
    const persona = await readPersona(deps.db, scope)
    if (!persona) return { priced: false, reason: 'no_persona' as const }

    const now = deps.now?.() ?? new Date()
    const discovery = rules().forLocale(null).discovery
    const staleBefore = new Date(
      now.getTime() - discovery.cache.keyword_metrics_ttl_days * 24 * 60 * 60 * 1000,
    )

    const due = await keywordsNeedingEnrichment(deps.db, scope, staleBefore, [payload.term])
    const row = due[0]
    if (!row) {
      // Either the merchant removed it again or something already priced it.
      // Both are ordinary and neither is worth a vendor call.
      return { priced: false, reason: 'already_fresh' as const }
    }

    const result = await pricedMetric(seo, {
      term: row.term,
      language: row.language,
      country: row.country,
      accountId: payload.accountId,
    })

    await upsertKeywords(deps.db, scope, [
      {
        term: row.term,
        language: row.language,
        country: row.country,
        volume: result.monthlySearchVolume,
        difficulty:
          result.competition === null
            ? null
            : Math.round(Math.min(1, Math.max(0, result.competition)) * 100),
        cpcUsd: result.cpcUsd,
        source: row.source,
        enrichedAt: now,
      },
    ])

    log.info('keyword_enrich.priced', { has_volume: result.monthlySearchVolume !== null })
    return { priced: true }
  })
}

async function pricedMetric(
  seo: SeoDataProvider,
  input: { term: string; language: string; country: string; accountId: string },
) {
  const result = await seo.keywordMetrics({
    keywords: [input.term],
    locale: { languageCode: input.language, countryCode: input.country },
    attribution: accountAttribution(input.accountId),
  })
  return (
    result.data[0] ?? {
      keyword: input.term,
      monthlySearchVolume: null,
      competition: null,
      cpcUsd: null,
      monthlyHistory: [],
    }
  )
}

let registered = false

export function registerKeywordEnrichTask(makeDeps: () => IngestionDeps): void {
  if (registered) return
  registered = true
  registerTask(KEYWORD_ENRICH_TASK, async (payload) => {
    const { accountId, term } = (payload ?? {}) as { accountId?: string; term?: string }
    if (!accountId || !term) throw new Error(`${KEYWORD_ENRICH_TASK} needs an accountId and a term`)
    await enrichKeyword(makeDeps(), { accountId, term })
  })
}

/** Test-only: the registry is a module singleton and so is this latch. */
export function resetKeywordEnrichTaskRegistration(): void {
  registered = false
}
