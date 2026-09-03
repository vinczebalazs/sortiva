import type { GenerationConfig } from '@sortiva/rules'
import type { SerpContext } from './evidence-pack'

/**
 * SERP-matched length, main §9.2: "the draft targets comparable coverage, not
 * a global word count... the SERP already encodes what depth ranks." No
 * fixed target — a band around the top results' own average, or a plain
 * floor when no result was readable at all.
 */
export interface LengthTarget {
  readonly minWords: number
  readonly maxWords: number
  readonly source: 'serp' | 'fallback'
}

export function lengthTargetFor(serp: SerpContext, config: GenerationConfig['length']): LengthTarget {
  if (serp.averageWordCount === null) {
    return { minWords: config.fallback_word_count_min, maxWords: config.fallback_word_count_min * 2, source: 'fallback' }
  }
  return {
    minWords: Math.round(serp.averageWordCount * config.serp_word_count_multiple_min),
    maxWords: Math.round(serp.averageWordCount * config.serp_word_count_multiple_max),
    source: 'serp',
  }
}
