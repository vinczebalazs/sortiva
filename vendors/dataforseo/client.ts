import { readFileSync } from 'node:fs'
import { DemandUnavailableError, type Demand, type Market, type RankingPage, type TopResults, type VolumeReading } from '../../core/demand.ts'
import { stableHash } from '../../core/hash.ts'
import { assertWithinBudget } from '../../core/spend.ts'
import type { Db } from '../../db/pool.ts'
import { ENDPOINTS, MAX_AGE_DAYS, MAX_TASKS_PER_POST, PRICE_USD, SERP_DEPTH } from './prices.ts'

const LOCATIONS = (JSON.parse(readFileSync(new URL('./locations.json', import.meta.url), 'utf8')) as { countries: Record<string, number> }).countries

export function locationCode(country: string): number {
  const code = LOCATIONS[country.toUpperCase()]
  if (!code) throw new DemandUnavailableError(`DataForSEO has no location for country ${country}`)
  return code
}

export type DataForSeoOptions = {
  login: string
  password: string
  baseUrl?: string
  /** How often a queued task is checked, and for how long before giving up. */
  pollMs?: number
  pollTimeoutMs?: number
}

type TaskResult = { id: string; status_code: number; status_message: string; cost: number; result: unknown[] | null }
type Envelope = { status_code: number; status_message: string; cost: number; tasks?: TaskResult[] | null }

type VolumeRow = { keyword: string; search_volume: number | null }
type SerpItem = { type: string; rank_group: number; url: string; domain: string; title: string | null; price: unknown }

// Codes DataForSEO uses for a queued task that is not finished yet.
const STILL_WORKING = new Set([40601, 40602])

// Paths a shop platform uses for product and category pages: Shopify, WooCommerce, Amazon, and the Hungarian "termék".
const PRODUCT_PATH = /\/(products?|collections|shop|p|dp|item|termek|termekek|kategoria)\//i

export function isProductListing(item: Pick<SerpItem, 'url' | 'price'>): boolean {
  if (item.price) return true
  try {
    return PRODUCT_PATH.test(new URL(item.url).pathname + '/')
  } catch {
    return false
  }
}

type SerpTask = { keyword: string; location_code: number; language_code: string; depth: number }

export class DataForSeoDemand implements Demand {
  private readonly baseUrl: string
  private readonly auth: string
  private readonly pollMs: number
  private readonly pollTimeoutMs: number

  constructor(private readonly db: Db, options: DataForSeoOptions) {
    this.baseUrl = options.baseUrl ?? 'https://api.dataforseo.com'
    this.auth = 'Basic ' + Buffer.from(`${options.login}:${options.password}`).toString('base64')
    this.pollMs = options.pollMs ?? 5_000
    this.pollTimeoutMs = options.pollTimeoutMs ?? 10 * 60_000
  }

  async searchVolumes({ storeId, market, keywords }: { storeId: number; market: Market; keywords: string[] }): Promise<VolumeReading[]> {
    const unique = [...new Set(keywords.map((k) => k.trim().toLowerCase()).filter(Boolean))].sort()
    if (!unique.length) return []
    const endpoint = ENDPOINTS.searchVolume
    const task = { keywords: unique, location_code: locationCode(market.country), language_code: market.language }
    const requestHash = stableHash({ endpoint, task })

    const cached = await this.fresh(requestHash, MAX_AGE_DAYS[endpoint])
    let envelope: Envelope
    let fetchedAt: string
    if (cached) {
      envelope = cached.response
      fetchedAt = cached.completedAt
    } else {
      const callId = await this.priced(storeId, endpoint, requestHash, task, PRICE_USD[endpoint])
      envelope = await this.send(callId, endpoint, [task])
      const failure = failureOf(envelope, envelope.tasks?.[0])
      if (failure) await this.fail(callId, endpoint, failure, envelope.cost ?? 0)
      await this.complete(callId, requestHash, envelope, envelope.cost)
      fetchedAt = new Date().toISOString()
    }
    const rows = (envelope.tasks?.[0]?.result ?? []) as VolumeRow[]
    const byKeyword = new Map(rows.map((r) => [r.keyword.toLowerCase(), r.search_volume]))
    return unique.map((keyword) => ({ keyword, searches: byKeyword.get(keyword) ?? null, source: `dataforseo:${endpoint}`, fetchedAt }))
  }

  /**
   * Submits every phrase without a fresh stored answer in one queued request, then collects each.
   * A task submitted by an earlier run that died is collected, not submitted and paid for again.
   */
  async topResults({ storeId, market, keywords }: { storeId: number; market: Market; keywords: string[] }): Promise<TopResults[]> {
    const tasks: SerpTask[] = keywords.map((k) => ({ keyword: k.trim().toLowerCase(), location_code: locationCode(market.country), language_code: market.language, depth: SERP_DEPTH }))
    const hashOf = (task: SerpTask) => stableHash({ endpoint: ENDPOINTS.topResultsPost, task })
    const answers = new Map<string, { envelope: Envelope; fetchedAt: string }>()
    const waiting: { callId: number; hash: string; taskId: string }[] = []
    const toPost: { task: SerpTask; hash: string }[] = []

    for (const task of tasks) {
      const hash = hashOf(task)
      if (answers.has(hash) || toPost.some((t) => t.hash === hash) || waiting.some((w) => w.hash === hash)) continue
      const cached = await this.fresh(hash, MAX_AGE_DAYS[ENDPOINTS.topResultsPost])
      if (cached) {
        answers.set(hash, { envelope: cached.response, fetchedAt: cached.completedAt })
        continue
      }
      const { rows } = await this.db.query<{ id: number; task_id: string }>(
        `select id::int, response->>'taskId' as task_id from vendor_calls
         where request_hash = $1 and status = 'pending' and response ? 'taskId' and created_at > now() - interval '1 day'
         order by id desc limit 1`,
        [hash],
      )
      if (rows[0]) waiting.push({ callId: rows[0].id, hash, taskId: rows[0].task_id })
      else toPost.push({ task, hash })
    }

    for (let i = 0; i < toPost.length; i += MAX_TASKS_PER_POST) {
      const batch = toPost.slice(i, i + MAX_TASKS_PER_POST)
      await assertWithinBudget(this.db, storeId, batch.length * PRICE_USD[ENDPOINTS.topResultsPost])
      const callIds: number[] = []
      for (const { task, hash } of batch) callIds.push(await this.priced(storeId, ENDPOINTS.topResultsPost, hash, task, PRICE_USD[ENDPOINTS.topResultsPost], false))
      const envelope = await this.send(callIds, ENDPOINTS.topResultsPost, batch.map((b) => b.task))
      for (const [j, { hash }] of batch.entries()) {
        const posted = envelope.tasks?.[j]
        if (envelope.status_code !== 20000 || posted?.status_code !== 20100) {
          for (const id of callIds.slice(j)) await this.markFailed(id, 0)
          const message = posted ? `${posted.status_code} ${posted.status_message}` : `${envelope.status_code} ${envelope.status_message}`
          throw new DemandUnavailableError(`DataForSEO ${ENDPOINTS.topResultsPost}: ${message}`, [40200, 40210].includes(posted?.status_code ?? envelope.status_code))
        }
        await this.db.query(`update vendor_calls set response = $2, cost_usd = $3 where id = $1`, [callIds[j], JSON.stringify({ taskId: posted.id }), posted.cost])
        waiting.push({ callId: callIds[j]!, hash, taskId: posted.id })
      }
    }

    const deadline = Date.now() + this.pollTimeoutMs
    let pending = waiting
    while (pending.length) {
      const still: typeof pending = []
      for (const w of pending) {
        const envelope = await this.get(`${ENDPOINTS.topResultsGet}/${w.taskId}`)
        const task = envelope.tasks?.[0]
        if (envelope.status_code === 20000 && task && STILL_WORKING.has(task.status_code)) {
          still.push(w)
          continue
        }
        const failure = failureOf(envelope, task)
        if (failure) await this.fail(w.callId, ENDPOINTS.topResultsGet, failure, null)
        await this.complete(w.callId, w.hash, envelope, null)
        answers.set(w.hash, { envelope, fetchedAt: new Date().toISOString() })
      }
      pending = still
      if (!pending.length) break
      // The submitted tasks stay pending in the ledger with their ids, so a later run collects them.
      if (Date.now() >= deadline) throw new DemandUnavailableError(`DataForSEO top results not ready after ${this.pollTimeoutMs} ms`)
      await new Promise((r) => setTimeout(r, this.pollMs))
    }

    return tasks.map((task) => {
      const { envelope, fetchedAt } = answers.get(hashOf(task))!
      const items = ((envelope.tasks?.[0]?.result?.[0] as { items?: SerpItem[] | null } | undefined)?.items ?? []).filter((i) => i.type === 'organic')
      const pages: RankingPage[] = items
        .sort((a, b) => a.rank_group - b.rank_group)
        .slice(0, SERP_DEPTH)
        .map((i) => ({ rank: i.rank_group, url: i.url, domain: i.domain, title: i.title ?? '', productListing: isProductListing(i) }))
      return { keyword: task.keyword, pages, source: `dataforseo:${ENDPOINTS.topResultsGet}`, fetchedAt }
    })
  }

  private async fresh(requestHash: string, maxAgeDays: number): Promise<{ response: Envelope; completedAt: string } | null> {
    const { rows } = await this.db.query<{ response: Envelope; completed_at: Date }>(
      `select response, completed_at from vendor_calls
       where request_hash = $1 and status = 'done' and completed_at > now() - make_interval(days => $2)`,
      [requestHash, maxAgeDays],
    )
    return rows[0] ? { response: rows[0].response, completedAt: rows[0].completed_at.toISOString() } : null
  }

  /** Checks the caps and writes the priced row before anything is sent (rule 7). */
  private async priced(storeId: number, endpoint: string, requestHash: string, task: unknown, estimate: number, checkCap = true): Promise<number> {
    if (checkCap) await assertWithinBudget(this.db, storeId, estimate)
    const { rows } = await this.db.query<{ id: number }>(
      `insert into vendor_calls (store_id, vendor, endpoint, request_hash, request, estimated_cost_usd)
       values ($1, 'dataforseo', $2, $3, $4, $5) returning id::int`,
      [storeId, endpoint, requestHash, JSON.stringify(task), estimate],
    )
    return rows[0]!.id
  }

  private async send(callIds: number | number[], endpoint: string, body: unknown[]): Promise<Envelope> {
    try {
      const res = await fetch(`${this.baseUrl}/v3/${endpoint}`, { method: 'POST', headers: { authorization: this.auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return (await res.json()) as Envelope
    } catch (error) {
      for (const id of [callIds].flat()) await this.markFailed(id, 0)
      throw new DemandUnavailableError(`DataForSEO ${endpoint}: ${(error as Error).message}`)
    }
  }

  private async get(path: string): Promise<Envelope> {
    try {
      const res = await fetch(`${this.baseUrl}/v3/${path}`, { headers: { authorization: this.auth } })
      return (await res.json()) as Envelope
    } catch (error) {
      throw new DemandUnavailableError(`DataForSEO ${path}: ${(error as Error).message}`)
    }
  }

  private async markFailed(callId: number, cost: number | null): Promise<void> {
    await this.db.query(`update vendor_calls set status = 'failed', cost_usd = coalesce($2, cost_usd), completed_at = now() where id = $1`, [callId, cost])
  }

  private async fail(callId: number, endpoint: string, failure: { code: number; message: string }, cost: number | null): Promise<never> {
    await this.markFailed(callId, cost)
    throw new DemandUnavailableError(`DataForSEO ${endpoint}: ${failure.code} ${failure.message}`, failure.code === 40200 || failure.code === 40210)
  }

  /** Stores the answer; an older answer to the same request is kept as superseded, because it was paid for. */
  private async complete(callId: number, requestHash: string, envelope: Envelope, cost: number | null): Promise<void> {
    const client = await this.db.connect()
    try {
      await client.query('begin')
      await client.query(`update vendor_calls set status = 'superseded' where request_hash = $1 and status = 'done'`, [requestHash])
      await client.query(`update vendor_calls set status = 'done', response = $2, cost_usd = coalesce($3, cost_usd), completed_at = now() where id = $1`, [callId, JSON.stringify(envelope), cost])
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }
}

function failureOf(envelope: Envelope, task: TaskResult | null | undefined): { code: number; message: string } | null {
  if (envelope.status_code !== 20000) return { code: envelope.status_code, message: envelope.status_message }
  if (!task) return { code: 0, message: 'no task in the answer' }
  if (task.status_code !== 20000) return { code: task.status_code, message: task.status_message }
  return null
}
