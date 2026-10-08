/**
 * The numbers behind a topic, each with where and when it came from. Stored as `topics.evidence`;
 * the queue's why line is rendered from this by a template, never written by a model.
 */
export type Evidence = {
  searches: { value: number | null; source: string; date: string; country: string; language: string }
  facts: { value: number; source: 'catalogue'; date: string }
  topResults: { top3: string[]; productListings: number; of: number; source: string; date: string } | null
}

/** Which sentence the why line uses; the screens hold the words for each, in both languages. */
export type WhyLine =
  | { kind: 'demand_no_page'; searches: number }
  | { kind: 'low_demand_manual' }

export function whyLine(evidence: Evidence, source: 'discovery' | 'manual'): WhyLine {
  const searches = evidence.searches.value
  if (source === 'manual' && (searches === null || searches === 0)) return { kind: 'low_demand_manual' }
  return { kind: 'demand_no_page', searches: searches ?? 0 }
}
