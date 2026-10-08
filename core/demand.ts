import type { Language } from './config.ts'

/** Where demand is measured: the store's customers' country, in the article language. */
export type Market = { country: string; language: Language }

export type VolumeReading = {
  keyword: string
  /** Monthly searches; null when the vendor has no figure for the phrase. */
  searches: number | null
  source: string
  fetchedAt: string
}

export type RankingPage = {
  rank: number
  url: string
  domain: string
  title: string
  /** A shop's product or category page rather than something an article competes with. */
  productListing: boolean
}

export type TopResults = { keyword: string; pages: RankingPage[]; source: string; fetchedAt: string }

/** Search demand and what ranks. Implemented in vendors/dataforseo; every call is priced and cached there. */
export interface Demand {
  searchVolumes(request: { storeId: number; market: Market; keywords: string[] }): Promise<VolumeReading[]>
  topResults(request: { storeId: number; market: Market; keyword: string }): Promise<TopResults>
}

/** The vendor could not answer. Discovery stops and is retried; it never continues without the numbers. */
export class DemandUnavailableError extends Error {
  constructor(message: string, readonly outOfFunds = false) {
    super(message)
  }
}
