/** Every tuned number in the product. Changing one is a decision; note it in DECISIONS.md. */
export const CONFIG = {
  model: 'claude-opus-5-5',
  // USD per million tokens for the model above.
  modelPrice: { input: 4, output: 20 },

  // A product with fewer facts than this is "needs a fuller description".
  minFactsPerProduct: 3,
  // Fewer adequate products than this puts the store in the thin-store state.
  thinStoreFloor: 5,

  // Sized so a page stays under Shopify's documented 1,000-point query ceiling.
  catalogPageSize: 15,
  // More product webhooks than this in one window means re-read the whole catalogue instead.
  webhookBurstThreshold: 25,
  webhookDebounceMs: 5_000,

  spendCapUsd: { perStoreDaily: 10, globalDaily: 60 },

  // Minimum monthly searches for a topic, per article language. The old build's locale floors, kept as the plan says.
  demandFloor: { en: 100, hu: 20 },
  topics: {
    // Waiting topics allowed for a store that is not thin; a thin store gets one per usable product.
    queueCap: 30,
    // Fewer waiting topics than this sends topic-finding out again, at most once per `rediscoverAfterDays`.
    lowQueue: 5,
    rediscoverAfterDays: 7,
    // Most candidates a single model call is asked for.
    maxCandidates: 20,
    // A word in at least this share of the store's titles is store-wide and ignored when comparing titles.
    storeWideWordShare: 0.3,
    // Top-three pages two queries must share to be the same intent.
    sharedTop3ForSameIntent: 2,
    // Distinct facts behind a topic at which its facts stop adding to its rank.
    factsForFullScore: 12,
  },
  minDistinctFactsPerArticle: 6,
  judgeFloors: { grounding: 4, informationGain: 4, other: 3 },
  write: {
    // Hungarian packs more into a word, so its range is lower (DECISIONS, "writing numbers").
    words: { en: { min: 700, max: 2000 }, hu: { min: 550, max: 1700 } },
    metaDescriptionChars: { min: 70, max: 170 },
    // Existing posts and collections offered to the writer as links, besides the products.
    maxLinkPages: 12,
    // Products whose facts the writer sees: the topic's own, plus ones from the same groups up to this many.
    maxProducts: 6,
  },
  defaultPublishHour: 9,
  productCardAspectRatio: 4 / 3,
  measureAfterDays: 28,
  deleteClosedStoreAfterDays: 30,
} as const

export type Language = 'en' | 'hu'
