import type { GatesConfig } from '@sortiva/rules'
import { accountAttribution } from '../../contracts/analytics'
import type { LlmClient, LlmRequest } from '../../contracts/llm'
import type { Draft } from '../../generation/draft'
import { containsWord, numbersIn, type CheckableLexicon } from './checkable'
import { sentencesOf, type ProseSentence } from './prose'

/**
 * Does the document contradict itself?
 *
 * An article that says "above 300 kg" in the introduction and "above 200 kg"
 * in section four passes every sentence-level check, because each sentence is
 * individually fine. This is the failure that embarrasses a merchant most, and
 * catching it means looking at the document as a whole.
 *
 * The work is split so almost all of it is free. Every number, threshold,
 * recommendation and absolute statement is extracted and **grouped
 * deterministically by what it is about**; agreement inside a group is
 * required arithmetically. Only pairs that genuinely disagree — same subject,
 * same direction, different figure — become *candidates*, and only candidates
 * are put to a model, whose single job is to say whether the two statements
 * are scoped differently ("above 300 kg for the outdoor range") or really do
 * conflict. A draft with no candidates costs nothing.
 */

export type StatementKind = 'threshold' | 'quantity' | 'recommendation' | 'absolute'

export interface ExtractedStatement {
  readonly kind: StatementKind
  readonly location: string
  readonly sentence: string
  /** `above` / `below` / `exactly` for a numeric statement; `for` / `against` for advice. */
  readonly direction: string
  readonly value: number | null
  readonly unit: string | null
  /** The content words the statement is about — what grouping compares. */
  readonly subject: readonly string[]
}

export interface CandidateConflict {
  readonly a: ExtractedStatement
  readonly b: ExtractedStatement
  readonly reason: string
}

export type ConflictRuling = 'contradiction' | 'scoped_differently'

export interface ConflictVerdict {
  readonly index: number
  readonly ruling: ConflictRuling
  readonly explanation: string
}

export interface ContradictionCheckResult {
  readonly passed: boolean
  readonly candidates: readonly CandidateConflict[]
  readonly contradictions: readonly { readonly candidate: CandidateConflict; readonly explanation: string }[]
  /** 0 when the deterministic pass found nothing to ask about. */
  readonly modelCalls: number
  readonly promptVersion: string | null
  readonly modelId: string | null
}

const ABOVE = ['above', 'over', 'more than', 'at least', 'from', 'exceeds', 'heavier than', 'greater than']
const BELOW = ['below', 'under', 'less than', 'at most', 'up to', 'fewer than', 'lighter than']

const UNIT_PATTERN =
  /(\d+(?:[.,]\d+)?)\s*(mm|cm|km|m|inches|inch|in|ft|feet|kg|g|lbs|lb|oz|ml|litres|liters|litre|liter|l|kw|w|v|hz|db|%|percent|years|year|months|month|weeks|week|days|day|hours|hour|minutes|minute)\b/giu

/**
 * Words that carry no information about *what* a statement is about: grammar,
 * the comparison words themselves, and the units — a unit is already matched
 * separately, and leaving it in the subject would make every pair of
 * measurements in the same unit look like it shared a subject.
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'is', 'are', 'be', 'with', 'this', 'that',
  'it', 'as', 'by', 'from', 'you', 'your', 'we', 'our', 'if', 'than', 'then', 'more', 'less', 'above', 'below',
  'over', 'under', 'about', 'any', 'can', 'will', 'should', 'when', 'up', 'out', 'not', 'but', 'so', 'its',
  'has', 'have', 'holds', 'hold', 'weighs', 'weigh', 'measures', 'needs', 'need', 'takes', 'take', 'gets',
  'litres', 'liters', 'litre', 'liter', 'kilograms', 'kilogram', 'grams', 'gram', 'metres', 'meters', 'metre',
  'meter', 'centimetres', 'centimeters', 'inches', 'inch', 'feet', 'foot', 'pounds', 'pound', 'ounces', 'ounce',
  'percent', 'seconds', 'second', 'minutes', 'minute', 'hours', 'hour', 'days', 'day', 'weeks', 'week',
  'months', 'month', 'years', 'year',
])

function subjectWords(sentence: string): string[] {
  return [
    ...new Set(
      sentence
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 2 && !STOP_WORDS.has(word) && !/^\d/.test(word)),
    ),
  ]
}

/**
 * Whole-word matching, not substring: "covers" contains "over", and reading
 * that as "over 20 litres" would turn an ordinary sentence into a threshold
 * pointing in a direction nobody wrote.
 */
function mentions(lower: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => new RegExp(`(?<![\\p{L}])${phrase}(?![\\p{L}])`, 'u').test(lower))
}

function directionOf(lower: string): 'above' | 'below' | 'exactly' {
  if (mentions(lower, ABOVE)) return 'above'
  if (mentions(lower, BELOW)) return 'below'
  return 'exactly'
}

function normaliseUnit(unit: string): string {
  const lower = unit.toLowerCase()
  if (lower === 'percent') return '%'
  if (lower === 'litres' || lower === 'liters' || lower === 'litre' || lower === 'liter') return 'l'
  if (lower === 'inches' || lower === 'inch') return 'in'
  if (lower === 'feet') return 'ft'
  if (lower === 'lbs') return 'lb'
  return lower.replace(/s$/, '')
}

export function extractStatements(draft: Draft, lexicon: CheckableLexicon | null): ExtractedStatement[] {
  const statements: ExtractedStatement[] = []

  for (const sentence of sentencesOf(draft)) {
    const lower = sentence.plain.toLowerCase()
    const subject = subjectWords(sentence.plain)
    const base = { location: sentence.block.label, sentence: sentence.plain, subject }

    const measured = [...sentence.plain.matchAll(UNIT_PATTERN)]
    for (const match of measured) {
      statements.push({
        ...base,
        kind: directionOf(lower) === 'exactly' ? 'quantity' : 'threshold',
        direction: directionOf(lower),
        value: Number(match[1]!.replace(',', '.')),
        unit: normaliseUnit(match[2]!),
      })
    }
    if (measured.length === 0) {
      for (const value of numbersIn(sentence.plain)) {
        statements.push({ ...base, kind: 'quantity', direction: directionOf(lower), value, unit: null })
      }
    }

    if (lexicon) {
      if (containsWord(lower, lexicon.recommendationVerbs)) {
        statements.push({
          ...base,
          kind: 'recommendation',
          direction: containsWord(lower, lexicon.negations) ? 'against' : 'for',
          value: null,
          unit: null,
        })
      }
      if (containsWord(lower, lexicon.absolutes)) {
        statements.push({
          ...base,
          kind: 'absolute',
          direction: containsWord(lower, lexicon.negations) ? 'against' : 'for',
          value: null,
          unit: null,
        })
      }
    }
  }

  return statements
}

/**
 * Are these two statements about the same thing?
 *
 * Measured as the overlap coefficient — shared subject words over the smaller
 * of the two sets — rather than as "they share a word". Two capacities in the
 * same range share the word "pack" and are not in conflict; a threshold
 * restated later in the article shares nearly everything it names. Using the
 * smaller set as the denominator is what lets a short restatement match a
 * longer original.
 */
function subjectOverlap(a: ExtractedStatement, b: ExtractedStatement): number {
  if (a.subject.length === 0 || b.subject.length === 0) return 0
  const other = new Set(b.subject)
  const shared = a.subject.filter((word) => other.has(word)).length
  return shared / Math.min(a.subject.length, b.subject.length)
}

function disagrees(a: number, b: number, tolerance: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1)
  return Math.abs(a - b) / scale > tolerance
}

/**
 * Pairs that genuinely disagree, found without a model. Two numeric statements
 * conflict when they measure the same unit, point the same way and name
 * different figures about an overlapping subject; two pieces of advice or two
 * absolutes conflict when they are about the same thing and point opposite
 * ways.
 */
export function candidateConflicts(
  statements: readonly ExtractedStatement[],
  config: GatesConfig['draft_lints'],
): CandidateConflict[] {
  const candidates: CandidateConflict[] = []

  for (let i = 0; i < statements.length; i += 1) {
    for (let j = i + 1; j < statements.length; j += 1) {
      const a = statements[i]!
      const b = statements[j]!
      if (a.sentence === b.sentence) continue
      if (a.kind !== b.kind) continue
      if (subjectOverlap(a, b) < config.contradiction_subject_overlap_min) continue

      if (a.value !== null && b.value !== null) {
        if (a.unit !== b.unit) continue
        if (a.direction !== b.direction) continue
        if (!disagrees(a.value, b.value, config.numeric_agreement_tolerance)) continue
        candidates.push({
          a,
          b,
          reason: `${a.direction} ${a.value}${a.unit ?? ''} in one place and ${b.direction} ${b.value}${b.unit ?? ''} in another, about the same thing`,
        })
        continue
      }

      if (a.value === null && b.value === null && a.direction !== b.direction) {
        candidates.push({ a, b, reason: `one of these is for and the other against, about the same thing` })
      }
    }
  }

  return candidates
}

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'ruling', 'explanation'],
        properties: {
          index: { type: 'integer', minimum: 0 },
          ruling: { type: 'string', enum: ['contradiction', 'scoped_differently'] },
          explanation: { type: 'string', minLength: 1 },
        },
      },
    },
  },
} as const

export interface ContradictionPrompt {
  readonly version: string
  readonly text: string
}

export function buildContradictionRequest(input: {
  readonly prompt: ContradictionPrompt
  readonly accountId: string
  readonly candidates: readonly CandidateConflict[]
}): LlmRequest {
  const pairs = input.candidates
    .map(
      (candidate, index) =>
        [
          `#${index}`,
          `A (${candidate.a.location}): ${candidate.a.sentence}`,
          `B (${candidate.b.location}): ${candidate.b.sentence}`,
          `Why they were flagged: ${candidate.reason}`,
        ].join('\n'),
    )
    .join('\n\n')

  return {
    // There is no `contradiction` call type in the frozen contract, and this
    // card may not add one. It is a grading call on the same tier as the
    // judge, so it runs as one and is told apart by its prompt version — see
    // DECISIONS 2026-09-03 T4.4.
    callType: 'judge',
    promptVersion: input.prompt.version,
    system: input.prompt.text,
    messages: [{ role: 'user', content: `Pairs to rule on:\n\n${pairs}` }],
    maxTokens: 1500,
    schema: RESPONSE_SCHEMA,
    attribution: accountAttribution(input.accountId),
  }
}

export interface ContradictionDeps {
  readonly llm: LlmClient
  readonly prompt: ContradictionPrompt
}

export async function checkContradictions(
  deps: ContradictionDeps,
  input: {
    readonly accountId: string
    readonly draft: Draft
    readonly lexicon: CheckableLexicon | null
    readonly config: GatesConfig['draft_lints']
  },
): Promise<ContradictionCheckResult> {
  const candidates = candidateConflicts(extractStatements(input.draft, input.lexicon), input.config)

  if (candidates.length === 0) {
    return { passed: true, candidates, contradictions: [], modelCalls: 0, promptVersion: null, modelId: null }
  }

  const result = await deps.llm.complete<{ verdicts: ConflictVerdict[] }>(
    buildContradictionRequest({ prompt: deps.prompt, accountId: input.accountId, candidates }),
  )

  const contradictions = result.output.verdicts
    .filter((verdict) => verdict.ruling === 'contradiction')
    .flatMap((verdict) => {
      const candidate = candidates[verdict.index]
      return candidate ? [{ candidate, explanation: verdict.explanation }] : []
    })

  return {
    passed: contradictions.length === 0,
    candidates,
    contradictions,
    modelCalls: 1,
    promptVersion: result.promptVersion,
    modelId: result.modelId,
  }
}

export type { ProseSentence }
