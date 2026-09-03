import { describe, expect, it } from 'vitest'
import { assembleEvidencePack } from './evidence-pack'
import { internalLinkTargetsFor, meetsInternalLinkMinimum } from './internal-links'

const CONFIG = { min_count: 1 }

function packWithLinkTasks(urls: readonly string[]) {
  return assembleEvidencePack({
    accountId: 'a1',
    topicId: 't1',
    intentClass: 'buying_guide',
    targetKeyword: 'k',
    families: [],
    products: [],
    serp: { keyword: 'k', locale: 'en-US', topResultCount: 0, averageWordCount: null, competitorAngles: [] },
    linkTasks: urls.map((url) => ({ url, reason: 'existing_target_weak_match' as const })),
    now: new Date(),
  })
}

describe('internalLinkTargetsFor', () => {
  it('carries the existing-target link task through, and adds one related article when any exist', () => {
    const pack = packWithLinkTasks(['/collections/trail'])
    const targets = internalLinkTargetsFor(pack, [{ url: '/blog/first-guide', title: 'First guide' }])
    expect(targets).toEqual([
      { url: '/collections/trail', reason: 'existing_target_weak_match' },
      { url: '/blog/first-guide', reason: 'related_article' },
    ])
  })

  it('requires no related-article link when the account has none yet', () => {
    const pack = packWithLinkTasks([])
    expect(internalLinkTargetsFor(pack, [])).toEqual([])
  })
})

describe('meetsInternalLinkMinimum', () => {
  it('passes when every required target is present', () => {
    const targets = [{ url: '/a', reason: 'existing_target_weak_match' as const }]
    expect(meetsInternalLinkMinimum(['/a', '/b'], targets, CONFIG)).toBe(true)
  })

  it('fails when a required target is missing', () => {
    const targets = [{ url: '/a', reason: 'existing_target_weak_match' as const }]
    expect(meetsInternalLinkMinimum(['/b'], targets, CONFIG)).toBe(false)
  })

  it('passes trivially when there is nothing to require', () => {
    expect(meetsInternalLinkMinimum([], [], CONFIG)).toBe(true)
  })
})
