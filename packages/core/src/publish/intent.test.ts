import { describe, expect, it } from 'vitest'
import {
  intentExternalId,
  publishMarker,
  recoveryDecision,
  RECOVERY_ABANDON_AFTER_MS,
  RECOVERY_GRACE_MS,
} from './intent'

const ARTICLE = '11111111-1111-4111-8111-111111111111'

describe('the marker that makes a remote post identifiable as ours', () => {
  it('is derived from the article, so a retry computes the same one', () => {
    expect(publishMarker(ARTICLE)).toBe(publishMarker(ARTICLE))
    expect(publishMarker(ARTICLE)).toContain(ARTICLE)
  })

  it('gives the first publication and its claim the same name', () => {
    expect(intentExternalId(ARTICLE, 0)).toBe(publishMarker(ARTICLE))
  })

  it('gives every republication a claim of its own', () => {
    expect(intentExternalId(ARTICLE, 1)).not.toBe(intentExternalId(ARTICLE, 0))
    expect(intentExternalId(ARTICLE, 2)).not.toBe(intentExternalId(ARTICLE, 1))
  })
})

describe('what the recovery sweep does with an unconfirmed claim', () => {
  it('leaves a young claim alone, in case a worker is still holding it', () => {
    expect(recoveryDecision({ ageMs: RECOVERY_GRACE_MS - 1, remoteArticleId: undefined })).toEqual({
      action: 'wait',
    })
  })

  it('adopts the post when the shop already carries our marker', () => {
    expect(recoveryDecision({ ageMs: RECOVERY_GRACE_MS, remoteArticleId: 'gid-9' })).toEqual({
      action: 'adopt',
      remoteArticleId: 'gid-9',
    })
  })

  it('adopts rather than abandons however old the claim is', () => {
    // An article demonstrably on the merchant's shop is a success whose
    // paperwork was lost. Abandoning it would leave a live post nothing knows about.
    expect(
      recoveryDecision({ ageMs: RECOVERY_ABANDON_AFTER_MS * 10, remoteArticleId: 'gid-9' }),
    ).toEqual({ action: 'adopt', remoteArticleId: 'gid-9' })
  })

  it('sends the post only after the shop has said it does not have it', () => {
    expect(recoveryDecision({ ageMs: RECOVERY_GRACE_MS, remoteArticleId: undefined })).toEqual({
      action: 'execute',
    })
  })

  it('gives up after three failed recoveries', () => {
    expect(
      recoveryDecision({ ageMs: RECOVERY_ABANDON_AFTER_MS, remoteArticleId: undefined }),
    ).toEqual({ action: 'abandon' })
  })
})
