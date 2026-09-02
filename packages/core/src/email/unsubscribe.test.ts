import { describe, expect, it } from 'vitest'
import {
  mintUnsubscribeToken,
  readUnsubscribeToken,
  unsubscribeHeaders,
  unsubscribeUrl,
} from './unsubscribe'

const SECRET = 'test-secret-not-a-real-one'
const claim = { accountId: 'acc-1', target: 'email_digest_frequency' } as const

describe('one-click unsubscribe links', () => {
  it('says which account and which setting, and survives a round trip', () => {
    const token = mintUnsubscribeToken(claim, SECRET)
    expect(readUnsubscribeToken(token, SECRET)).toEqual(claim)
  })

  it('cannot be edited into somebody else’s account', () => {
    const token = mintUnsubscribeToken(claim, SECRET)
    const [, target, signature] = token.split('.')
    expect(readUnsubscribeToken(`acc-2.${target}.${signature}`, SECRET)).toBeUndefined()
  })

  it('cannot be pointed at a setting it was not signed for', () => {
    const token = mintUnsubscribeToken(claim, SECRET)
    const [accountId, , signature] = token.split('.')
    expect(
      readUnsubscribeToken(`${accountId}.email_article_published.${signature}`, SECRET),
    ).toBeUndefined()
  })

  it('rejects a setting name we never sign', () => {
    expect(readUnsubscribeToken('acc-1.delete_account.whatever', SECRET)).toBeUndefined()
  })

  it('rejects a token minted with a different secret', () => {
    expect(readUnsubscribeToken(mintUnsubscribeToken(claim, 'other'), SECRET)).toBeUndefined()
  })

  it('refuses to sign without a secret rather than signing with an empty one', () => {
    expect(() => mintUnsubscribeToken(claim, '')).toThrow()
  })

  it('carries the header that makes it one click rather than a hint', () => {
    // Without List-Unsubscribe-Post the mail client opens a browser instead of
    // acting, and the merchant reports us as spam instead (RFC 8058).
    const url = unsubscribeUrl('https://sortiva.app/', 'tok')
    expect(url).toBe('https://sortiva.app/api/notifications/unsubscribe?token=tok')
    expect(unsubscribeHeaders(url)).toEqual({
      'List-Unsubscribe': `<${url}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    })
  })
})
