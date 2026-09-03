import type { IntentClass, QueryCluster } from '../contracts/opportunities'

/**
 * Section shapes: `docs/content-pointers.md` §4. Two (`buying_guide`,
 * `comparison`) already existed in the product's design; the other five are
 * this card's addition, each with a named failure condition — "the thing
 * that makes a shape checkable rather than decorative."
 *
 * `topics.intent_class` (schema wave 3, `T4.0`) is a closed four-value enum —
 * `buying_guide | comparison | how_to | informational` — and cannot gain a
 * fifth value without a migration this card may not add. `ArticleShape` is
 * therefore a Lane-D-internal, non-persisted refinement of it: `selectShape`
 * picks one of the seven from the intent class plus the cluster's own words,
 * deterministically and without a model call. See DECISIONS 2026-09-03 T4.3
 * — this mapping is this card's own call, reversible, and touches no other
 * lane's interface.
 */

export const ARTICLE_SHAPES = [
  'buying_guide',
  'comparison',
  'sizing',
  'how_to',
  'troubleshooting',
  'informational_commercial',
  'category_explainer',
] as const
export type ArticleShape = (typeof ARTICLE_SHAPES)[number]

export interface ShapeSkeleton {
  readonly shape: ArticleShape
  /** Section headings, in order. `{{axis}}` sections are expanded per family axis by `sectionsFor`. */
  readonly sections: readonly string[]
  /** Which sections, if any, expand once per differentiation axis (main §9.2). */
  readonly axisDerivedSections: readonly string[]
  /** The named failure condition, `content-pointers.md` §4 — for the reason card and for tests. */
  readonly failureCondition: string
}

const SKELETONS: Readonly<Record<ArticleShape, ShapeSkeleton>> = {
  comparison: {
    shape: 'comparison',
    sections: ['Verdict', 'At a glance', 'Who should choose each', 'Decision factors', 'Products', 'Edge cases'],
    axisDerivedSections: ['Decision factors'],
    failureCondition: 'refuses to recommend — "it depends on your needs" is a non-answer',
  },
  buying_guide: {
    shape: 'buying_guide',
    sections: ['The decision', 'Selection criteria', 'Recommended types', 'Common mistakes', 'Products'],
    axisDerivedSections: ['Selection criteria'],
    failureCondition: 'selection criteria are missing, so the recommendation is arbitrary',
  },
  sizing: {
    shape: 'sizing',
    sections: ['Direct answer', 'Size table', 'How to calculate', 'Worked examples', 'Edge cases', 'Products'],
    axisDerivedSections: [],
    failureCondition: 'the answer is not in the first paragraph',
  },
  how_to: {
    shape: 'how_to',
    sections: ['Outcome', 'Prerequisites', 'Steps', 'Common errors', 'Products'],
    axisDerivedSections: [],
    failureCondition: 'steps generic enough to apply to anything; "done" is never defined',
  },
  troubleshooting: {
    shape: 'troubleshooting',
    sections: ['Symptom', 'Probable causes', 'Diagnosis', 'Solutions', 'Prevention'],
    axisDerivedSections: [],
    failureCondition: 'causes not ordered by likelihood',
  },
  informational_commercial: {
    shape: 'informational_commercial',
    sections: ['Direct answer', 'Explanation', 'Decision implications', 'Relevant products'],
    axisDerivedSections: [],
    failureCondition: 'it never reaches the decision',
  },
  category_explainer: {
    shape: 'category_explainer',
    sections: ['What the category is', 'How options differ', 'How to choose', 'The range'],
    axisDerivedSections: ['How options differ'],
    failureCondition: 'it becomes a catalogue listing',
  },
}

export function skeletonFor(shape: ArticleShape): ShapeSkeleton {
  return SKELETONS[shape]
}

/** A skeleton's axis-derived sections, expanded into one subsection per axis — main §9.2: "by terrain / for wide feet / by budget" is literally the axis list. */
export function sectionsFor(shape: ArticleShape, axes: readonly string[]): readonly string[] {
  const skeleton = SKELETONS[shape]
  if (skeleton.axisDerivedSections.length === 0 || axes.length === 0) return skeleton.sections
  const out: string[] = []
  for (const section of skeleton.sections) {
    if (!skeleton.axisDerivedSections.includes(section)) {
      out.push(section)
      continue
    }
    for (const axis of axes) out.push(`${section}: by ${axis}`)
  }
  return out
}

const PROBLEM_WORDS = ['fix', 'broken', 'troubleshoot', 'not working', "won't", 'wont', "doesn't work", 'issue', 'problem', 'repair']
const SIZING_WORDS = ['size', 'sizing', 'size chart', 'fit guide', 'what size']

/**
 * Picks a shape from the topic's intent class plus its own words —
 * deterministic, no model call, so it costs nothing beyond what Gate 1
 * already paid for the cluster. `buying_guide` and `comparison` map
 * one-to-one; `how_to` and `informational` each refine into one of two
 * shapes by a small keyword heuristic, UNSIGNED like every other heuristic in
 * this card that main §4/§9.2 does not give a rule for.
 */
export function selectShape(intentClass: IntentClass, cluster: Pick<QueryCluster, 'head' | 'members'>): ArticleShape {
  const words = [cluster.head, ...cluster.members].join(' ').toLowerCase()

  if (intentClass === 'buying_guide') return 'buying_guide'
  if (intentClass === 'comparison') return 'comparison'
  if (intentClass === 'how_to') {
    return PROBLEM_WORDS.some((w) => words.includes(w)) ? 'troubleshooting' : 'how_to'
  }
  // informational
  if (SIZING_WORDS.some((w) => words.includes(w))) return 'sizing'
  return 'category_explainer'
}
