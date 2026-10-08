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

  // Minimum monthly searches for a topic, per article language.
  demandFloor: { en: 50, hu: 20 },
  minDistinctFactsPerArticle: 6,
  judgeFloors: { grounding: 4, informationGain: 4, other: 3 },
  defaultPublishHour: 9,
  productCardAspectRatio: 4 / 3,
  measureAfterDays: 28,
  deleteClosedStoreAfterDays: 30,
} as const

export type Language = 'en' | 'hu'
