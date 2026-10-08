import { readFileSync } from 'node:fs'
import { DemandUnavailableError, type Demand, type Market, type RankingPage, type TopResults, type VolumeReading } from '../../core/demand.ts'
import { stableHash } from '../../core/hash.ts'
import { assertWithinBudget } from '../../core/spend.ts'
import type { Db } from '../../db/pool.ts'
import { ENDPOINTS, MAX_AGE_DAYS, PRICE_USD, SERP_DEPTH, type Endpoint } from './prices.ts'

const LOCATIONS = (JSON.parse(readFileSync(new URL('./locations.json', import.meta.url), 'utf8')) as { countries: Record<string, number> }).countries

export function locationCode(country: string): number {
  const code = LOCATIONS[country.toUpperCase()]
  if (!code) throw new DemandUnavailableError(`DataForSEO has no location for country ${country}`)
  return code
}

export type DataForSeoOptions = { login: string; password: string; baseUrl?: string }

type Envelope = {
  status_code: number
  status_message: string
  cost: number
  tasks?: { status_code: number; status_message: string; cost: number; result: unknown[] | null }[]
}

type VolumeRow = { keyword: string; search_volume: number | null }
type SerpItem = { type: string; rank_group: number; url: string; domain: string; title: string | null; price: unknown }

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

export class DataForSeoDemand implements Demand {
  private readonly baseUrl: string
  private readonly auth: string

  constructor(private readonly db: Db, options: DataForSeoOptions) {
    this.baseUrl = options.baseUrl ?? 'https://api.dataforseo.com'
    this.auth = 'Basic ' + Buffer.from(`${options.login}:${options.password}`).toString('base64')
  }

  async searchVolumes({ storeId, market, keywords }: { storeId: number; market: Market; keywords: string[] }): Promise<VolumeReading[]> {
    const unique = [...new Set(keywords.map((k) => k.trim().toLowerCase()).filter(Boolean))].sort()
    if (!unique.length) return []
    const task = { keywords: unique, location_code: locationCode(market.country), language_code: market.language }
    const { result, fetchedAt } = await this.call(storeId, ENDPOINTS.searchVolume, task)
    const byKeyword = new Map((result as VolumeRow[]).map((r) => [r.keyword.toLowerCase(), r.search_volume]))
    return unique.map((keyword) => ({ keyword, searches: byKeyword.get(keyword) ?? null, source: `dataforseo:${ENDPOINTS.searchVolume}`, fetchedAt }))
  }

  async topResults({ storeId, market, keyword }: { storeId: number; market: Market; keyword: string }): Promise<TopResults> {
    const task = { keyword: keyword.trim().toLowerCase(), location_code: locationCode(market.country), language_code: market.language, depth: SERP_DEPTH }
    const { result, fetchedAt } = await this.call(storeId, ENDPOINTS.topResults, task)
    const items = ((result[0] as { items?: SerpItem[] | null } | undefined)?.items ?? []).filter((i) => i.type === 'organic')
    const pages: RankingPage[] = items
      .sort((a, b) => a.rank_group - b.rank_group)
      .slice(0, SERP_DEPTH)
      .map((i) => ({ rank: i.rank_group, url: i.url, domain: i.domain, title: i.title ?? '', productListing: isProductListing(i) }))
    return { keyword: task.keyword, pages, source: `dataforseo:${ENDPOINTS.topResults}`, fetchedAt }
  }

  /** One billable request: a fresh stored answer if there is one, else priced, capped, recorded, then sent. */
  private async call(storeId: number, endpoint: Endpoint, task: Record<string, unknown>): Promise<{ result: unknown[]; fetchedAt: string }> {
    const requestHash = stableHash({ endpoint, task })
    const cached = await this.db.query<{ response: Envelope; completed_at: Date; fresh: boolean }>(
      `select response, completed_at, completed_at > now() - make_interval(days => $2) as fresh
       from vendor_calls where request_hash = $1 and status = 'done'`,
      [requestHash, MAX_AGE_DAYS[endpoint]],
    )
    if (cached.rows[0]?.fresh) return { result: resultOf(cached.rows[0].response), fetchedAt: cached.rows[0].completed_at.toISOString() }

    const estimate = PRICE_USD[endpoint]
    await assertWithinBudget(this.db, storeId, estimate)
    const { rows } = await this.db.query<{ id: number }>(
      `insert into vendor_calls (store_id, vendor, endpoint, request_hash, request, estimated_cost_usd)
       values ($1, 'dataforseo', $2, $3, $4, $5) returning id`,
      [storeId, endpoint, requestHash, JSON.stringify(task), estimate],
    )
    const callId = rows[0]!.id
    const fail = async (message: string, cost: number, outOfFunds = false): Promise<never> => {
      await this.db.query(`update vendor_calls set status = 'failed', cost_usd = $2, completed_at = now() where id = $1`, [callId, cost])
      throw new DemandUnavailableError(`DataForSEO ${endpoint}: ${message}`, outOfFunds)
    }

    let envelope: Envelope
    try {
      const res = await fetch(`${this.baseUrl}/v3/${endpoint}`, {
        method: 'POST',
        headers: { authorization: this.auth, 'content-type': 'application/json' },
        body: JSON.stringify([task]),
      })
      envelope = (await res.json()) as Envelope
    } catch (error) {
      return fail((error as Error).message, 0)
    }
    const taskResult = envelope.tasks?.[0]
    const code = taskResult?.status_code ?? envelope.status_code
    if (envelope.status_code !== 20000 || code !== 20000) {
      const message = taskResult?.status_message ?? envelope.status_message
      return fail(`${code} ${message}`, envelope.cost ?? 0, code === 40200 || code === 40210)
    }

    const client = await this.db.connect()
    try {
      await client.query('begin')
      await client.query(`update vendor_calls set status = 'superseded' where request_hash = $1 and status = 'done'`, [requestHash])
      await client.query(`update vendor_calls set status = 'done', response = $2, cost_usd = $3, completed_at = now() where id = $1`, [callId, JSON.stringify(envelope), envelope.cost])
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
    return { result: resultOf(envelope), fetchedAt: new Date().toISOString() }
  }
}

function resultOf(envelope: Envelope): unknown[] {
  return envelope.tasks?.[0]?.result ?? []
}
