import { describe, expect, it } from 'vitest'
import { strandedProgress, triageStrandedRuns, type StrandedRun } from './stranded'

function run(overrides: Partial<StrandedRun> & Pick<StrandedRun, 'topicId' | 'scheduledDate'>): StrandedRun {
  return { articleId: null, hasStoredDraft: false, ...overrides }
}

describe('how far a stranded run got', () => {
  it('ranks a stored draft above an article row above nothing at all', () => {
    expect(strandedProgress(run({ topicId: 'a', scheduledDate: '2026-09-01' }))).toBe(0)
    expect(strandedProgress(run({ topicId: 'b', scheduledDate: '2026-09-01', articleId: 'x' }))).toBe(1)
    expect(
      strandedProgress(run({ topicId: 'c', scheduledDate: '2026-09-01', articleId: 'x', hasStoredDraft: true })),
    ).toBe(2)
  })
})

describe('deciding which stranded run is finished', () => {
  it('has nothing to finish and nothing to abandon when nothing is stranded', () => {
    expect(triageStrandedRuns([])).toEqual({ finish: undefined, abandon: [] })
  })

  it('finishes the only one there is, which is the ordinary case', () => {
    const only = run({ topicId: 'a', scheduledDate: '2026-09-03', articleId: 'x' })
    expect(triageStrandedRuns([only])).toEqual({ finish: only, abandon: [] })
  })

  it('finishes the one whose writer already ran, whatever day it is from', () => {
    const older = run({ topicId: 'old', scheduledDate: '2026-08-20', articleId: 'x', hasStoredDraft: true })
    const newer = run({ topicId: 'new', scheduledDate: '2026-09-03', articleId: 'y' })
    const triage = triageStrandedRuns([newer, older])
    expect(triage.finish).toBe(older)
    expect(triage.abandon).toEqual([newer])
  })

  it('prefers the more recent day when two got equally far', () => {
    const older = run({ topicId: 'old', scheduledDate: '2026-08-20', articleId: 'x' })
    const newer = run({ topicId: 'new', scheduledDate: '2026-09-03', articleId: 'y' })
    const triage = triageStrandedRuns([older, newer])
    expect(triage.finish).toBe(newer)
    expect(triage.abandon).toEqual([older])
  })

  it('abandons every one it did not pick, so none is left waiting for a later pass', () => {
    const runs = [
      run({ topicId: 'a', scheduledDate: '2026-09-01' }),
      run({ topicId: 'b', scheduledDate: '2026-09-02' }),
      run({ topicId: 'c', scheduledDate: '2026-09-03', articleId: 'x', hasStoredDraft: true }),
    ]
    const triage = triageStrandedRuns(runs)
    expect(triage.finish?.topicId).toBe('c')
    expect(triage.abandon.map((r) => r.topicId)).toEqual(['b', 'a'])
  })

  it('does not reorder the caller\'s array', () => {
    const runs = [
      run({ topicId: 'a', scheduledDate: '2026-09-01' }),
      run({ topicId: 'b', scheduledDate: '2026-09-03' }),
    ]
    triageStrandedRuns(runs)
    expect(runs.map((r) => r.topicId)).toEqual(['a', 'b'])
  })
})
