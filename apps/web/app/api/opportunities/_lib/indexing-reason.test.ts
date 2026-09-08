import { describe, expect, it } from 'vitest'
import { reasonFor } from '@sortiva/core'
import type { IndexingIssueSignal } from '@sortiva/core/opportunities/p1-signal-shapes'
import { renderTemplatedLine } from '@sortiva/ui/opportunities/why'

/**
 * A page Google has not indexed and a page Google is folding into another are
 * different problems with different remedies, and the merchant used to be told
 * about both with one sentence that named neither.
 *
 * The difference between them arrives as a machine word, which is not something
 * to print — so it picks the sentence rather than filling one. That makes the
 * split invisible to the guard that compares the numbers a sentence asks for
 * against the numbers the scan sends: both sentences ask for nothing, so both
 * pass whether or not they are the same sentence.
 *
 * This is the check from the merchant's side, and it lives here rather than in
 * `packages/core` because the engine cannot see the words — the sentences are
 * in the front end's catalogue and the engine only ever emits keys.
 */

function signal(reason: IndexingIssueSignal['reason']): IndexingIssueSignal {
  return {
    signalType: 'indexing_issue',
    page: 'https://example.com/collections/boots',
    pageType: 'collection',
    reason,
    evidence: [],
  }
}

describe('the two indexing problems a merchant can be told about', () => {
  it('are named by two different keys', () => {
    expect(reasonFor(signal('not_indexed'), 'FIX').reasonTemplateKey).not.toBe(
      reasonFor(signal('canonical_mismatch'), 'FIX').reasonTemplateKey,
    )
  })

  it('never offer the machine word to a sentence that could print it', () => {
    for (const reason of ['not_indexed', 'canonical_mismatch'] as const) {
      expect(reasonFor(signal(reason), 'FIX').reasonParams).toEqual({})
    }
  })

  it('read as two different sentences, and neither is the renderer giving up', () => {
    const lines = (['not_indexed', 'canonical_mismatch'] as const).map((reason) => {
      const { reasonTemplateKey, reasonParams } = reasonFor(signal(reason), 'FIX')
      return renderTemplatedLine({ templateKey: reasonTemplateKey, params: reasonParams })
    })

    for (const line of lines) {
      expect(line.known, 'fell through to the "no reasoning yet" line').toBe(true)
      expect(line.text.trim().length).toBeGreaterThan(0)
    }
    expect(
      lines[0]!.text,
      'both conditions render the same words, which is the fault this split was meant to end',
    ).not.toBe(lines[1]!.text)
  })

  it('does not print a machine word at a merchant', () => {
    for (const reason of ['not_indexed', 'canonical_mismatch'] as const) {
      const { reasonTemplateKey, reasonParams } = reasonFor(signal(reason), 'FIX')
      const { text } = renderTemplatedLine({ templateKey: reasonTemplateKey, params: reasonParams })
      expect(text).not.toContain('not_indexed')
      expect(text).not.toContain('canonical_mismatch')
      expect(text).not.toContain('{')
    }
  })
})
