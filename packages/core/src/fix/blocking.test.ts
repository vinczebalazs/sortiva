import { describe, expect, it } from 'vitest'
import {
  blockingFixesByEntity,
  blockingPreconditionsFor,
  type BlockingCandidateRow,
} from './blocking'

const COLLECTION = 'https://shop.example/collections/trail-running'

function row(overrides: Partial<BlockingCandidateRow>): BlockingCandidateRow {
  return {
    signalType: 'indexing_issue',
    entityRef: COLLECTION,
    recommendedAction: 'fix',
    status: 'new',
    ...overrides,
  }
}

describe('a technical obstacle on a page blocks content work on that page', () => {
  it('blocks an improve-this-page suggestion on the same collection', () => {
    expect(blockingPreconditionsFor(COLLECTION, 'optimize', [row({})])).toEqual(['indexing_issue'])
  })

  it('blocks a new-article suggestion on the same page too', () => {
    expect(blockingPreconditionsFor(COLLECTION, 'create', [row({})])).toEqual(['indexing_issue'])
  })

  it('leaves a different page alone', () => {
    expect(
      blockingPreconditionsFor('https://shop.example/collections/road', 'optimize', [row({})]),
    ).toEqual([])
  })

  it('ignores a trailing slash, so the same page is the same page', () => {
    expect(blockingPreconditionsFor(`${COLLECTION}/`, 'optimize', [row({})])).toEqual([
      'indexing_issue',
    ])
  })

  it('accepts the action name in either casing, because the two halves of the product spell it differently', () => {
    expect(blockingPreconditionsFor(COLLECTION, 'OPTIMIZE', [row({})])).toEqual(['indexing_issue'])
  })
})

describe('what does not block', () => {
  it('the store competing with itself — that is editorial work, not an obstacle', () => {
    expect(
      blockingPreconditionsFor(COLLECTION, 'optimize', [row({ signalType: 'cannibalization' })]),
    ).toEqual([])
  })

  it('a closed obstacle: dismissed, completed or expired rows are history', () => {
    for (const status of ['dismissed', 'completed', 'expired']) {
      expect(blockingPreconditionsFor(COLLECTION, 'optimize', [row({ status })])).toEqual([])
    }
  })

  it('an obstacle that is not a FIX', () => {
    expect(
      blockingPreconditionsFor(COLLECTION, 'optimize', [row({ recommendedAction: 'optimize' })]),
    ).toEqual([])
  })

  it('another FIX — one obstacle never hides the work of clearing another', () => {
    expect(blockingPreconditionsFor(COLLECTION, 'fix', [row({})])).toEqual([])
  })

  it('a rewrite of one of our own articles, which is not content work on their page', () => {
    expect(blockingPreconditionsFor(COLLECTION, 'refresh', [row({})])).toEqual([])
  })
})

describe('the lookup the whole rule is built on', () => {
  it('names the obstacle, so the card can say what is in the way', () => {
    const found = blockingFixesByEntity([row({}), row({ signalType: 'cannibalization' })])
    expect([...found.entries()]).toEqual([[COLLECTION, 'indexing_issue']])
  })
})
