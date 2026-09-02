import { describe, expect, it } from 'vitest'
import {
  ATTENTION_KINDS,
  EXPORT_URL_UNCONFIRMED_DAYS,
  OPTIMIZE_UNAPPLIED_DAYS,
  buildAttentionList,
  cutoffDaysBefore,
  type AttentionCandidate,
  type AttentionSources,
} from './attention'

const NOW = new Date('2026-09-02T09:00:00Z')

/**
 * A stand-in for the tables the readers query, so the list's behaviour can be
 * tested without one. `drafts` is the state a merchant changes by approving;
 * nothing here has a method that writes, which is the property under test.
 */
function fakeSources(state: {
  drafts?: AttentionCandidate[]
  repairs?: AttentionCandidate[]
  exports?: AttentionCandidate[]
  tasks?: AttentionCandidate[]
  optimizes?: AttentionCandidate[]
}): AttentionSources {
  return {
    draftsAwaitingReview: async () => state.drafts ?? [],
    pendingRepairs: async () => state.repairs ?? [],
    unconfirmedExportUrls: async () => state.exports ?? [],
    openMerchantTasks: async () => state.tasks ?? [],
    unappliedOptimizeRecommendations: async () => state.optimizes ?? [],
  }
}

describe('the attention list', () => {
  it('is empty when nothing needs the merchant', async () => {
    expect(await buildAttentionList(fakeSources({}), NOW)).toEqual([])
  })

  it('drops a draft the moment it is approved, and writes nothing to do it', async () => {
    const state: { drafts: AttentionCandidate[] } = {
      drafts: [{ refs: { article_id: 'a-1' }, since: new Date('2026-09-01T08:00:00Z') }],
    }
    const sources = fakeSources(state)

    expect(await buildAttentionList(sources, NOW)).toEqual([
      { kind: 'draft_awaiting_review', refs: { article_id: 'a-1' }, since: state.drafts[0]!.since },
    ])

    // Approving is a change to the article, not to a list: the row leaves
    // `in_review` and the query that produced the item stops matching it.
    state.drafts = []

    expect(await buildAttentionList(sources, NOW)).toEqual([])
  })

  it('offers no way to write — every member of the port is a reader', () => {
    // If clearing an item ever needed a call, the item would be a stored record
    // and could go stale. It cannot, because there is nothing to call.
    expect(Object.keys(fakeSources({})).sort()).toEqual(
      [
        'draftsAwaitingReview',
        'openMerchantTasks',
        'pendingRepairs',
        'unappliedOptimizeRecommendations',
        'unconfirmedExportUrls',
      ].sort(),
    )
  })

  it('orders by how much is being asked of the merchant, oldest first inside a kind', async () => {
    const older = new Date('2026-08-20T00:00:00Z')
    const newer = new Date('2026-08-30T00:00:00Z')
    const items = await buildAttentionList(
      fakeSources({
        optimizes: [{ refs: { opportunity_id: 'o-1' }, since: older }],
        tasks: [
          { refs: { opportunity_id: 'o-2' }, since: newer },
          { refs: { opportunity_id: 'o-3' }, since: older },
        ],
        drafts: [{ refs: { article_id: 'a-1' }, since: newer }],
      }),
      NOW,
    )

    expect(items.map((item) => [item.kind, Object.values(item.refs)[0]])).toEqual([
      ['draft_awaiting_review', 'a-1'],
      ['merchant_task', 'o-3'],
      ['merchant_task', 'o-2'],
      ['optimize_unapplied', 'o-1'],
    ])
  })

  it('covers every kind the API contract names', () => {
    expect([...ATTENTION_KINDS]).toEqual([
      'draft_awaiting_review',
      'repair_pending',
      'export_url_unconfirmed',
      'merchant_task',
      'optimize_unapplied',
    ])
  })

  it('computes a cutoff a whole number of days back', () => {
    expect(cutoffDaysBefore(NOW, EXPORT_URL_UNCONFIRMED_DAYS).toISOString()).toBe(
      '2026-08-26T09:00:00.000Z',
    )
    expect(cutoffDaysBefore(NOW, OPTIMIZE_UNAPPLIED_DAYS).toISOString()).toBe(
      '2026-08-19T09:00:00.000Z',
    )
  })
})
