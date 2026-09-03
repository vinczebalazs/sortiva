import { describe, expect, it } from 'vitest'
import {
  isMovable,
  isPinnable,
  isVetoable,
  moveConflictCodeFor,
  VETO_CONFLICT_CODE,
} from './transitions'

describe('isVetoable', () => {
  it('allows veto from planned, generating and in_review', () => {
    expect(isVetoable('planned')).toBe(true)
    expect(isVetoable('generating')).toBe(true)
    expect(isVetoable('in_review')).toBe(true)
  })

  it('refuses veto once a topic has resolved', () => {
    expect(isVetoable('published')).toBe(false)
    expect(isVetoable('rejected_by_gate')).toBe(false)
    expect(isVetoable('vetoed')).toBe(false)
  })
})

describe('VETO_CONFLICT_CODE', () => {
  it('is the one code the frozen route contract names for this route', () => {
    expect(VETO_CONFLICT_CODE).toBe('topic_already_published')
  })
})

describe('isMovable and isPinnable', () => {
  it('only a planned topic may be dragged', () => {
    expect(isMovable('planned')).toBe(true)
    expect(isMovable('generating')).toBe(false)
    expect(isMovable('in_review')).toBe(false)
    expect(isMovable('published')).toBe(false)
  })

  it('pin is refused only once a topic has actually published', () => {
    expect(isPinnable('planned')).toBe(true)
    expect(isPinnable('generating')).toBe(true)
    expect(isPinnable('rejected_by_gate')).toBe(true)
    expect(isPinnable('vetoed')).toBe(true)
    expect(isPinnable('published')).toBe(false)
  })
})

describe('moveConflictCodeFor', () => {
  it('names the generating race explicitly', () => {
    expect(moveConflictCodeFor('generating')).toBe('topic_already_generating')
  })

  it('falls back to the published code for every other resolved state', () => {
    expect(moveConflictCodeFor('published')).toBe('topic_already_published')
    expect(moveConflictCodeFor('rejected_by_gate')).toBe('topic_already_published')
    expect(moveConflictCodeFor('vetoed')).toBe('topic_already_published')
    expect(moveConflictCodeFor('in_review')).toBe('topic_already_published')
  })
})
