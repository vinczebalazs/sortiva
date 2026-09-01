import { describe, expect, it, vi } from 'vitest'
import { CloudflareTurnstile, MockTurnstile, TurnstileNotConfigured } from './index'

describe('CloudflareTurnstile', () => {
  it('refuses to construct without a secret, rather than passing everything through', () => {
    expect(() => new CloudflareTurnstile({ secretKey: undefined })).toThrowError(
      TurnstileNotConfigured,
    )
  })

  it('posts the token and the visitor IP to siteverify', async () => {
    const calls: { url: string; body: string }[] = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), body: String((init as RequestInit).body) })
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const verifier = new CloudflareTurnstile({ secretKey: 'sk_test' })
    const result = await verifier.verify('token-abc', '203.0.113.7')

    expect(result.success).toBe(true)
    expect(calls[0]?.url).toContain('/turnstile/v0/siteverify')
    expect(calls[0]?.body).toContain('secret=sk_test')
    expect(calls[0]?.body).toContain('response=token-abc')
    expect(calls[0]?.body).toContain('remoteip=203.0.113.7')
    fetchSpy.mockRestore()
  })

  it('reports Cloudflare error codes rather than swallowing them', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, 'error-codes': ['timeout-or-duplicate'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const result = await new CloudflareTurnstile({ secretKey: 'sk' }).verify('t')
    expect(result).toEqual({ success: false, errorCodes: ['timeout-or-duplicate'] })
    fetchSpy.mockRestore()
  })

  it('fails closed when Cloudflare is unreachable', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'))
    const result = await new CloudflareTurnstile({ secretKey: 'sk' }).verify('t')
    expect(result.success).toBe(false)
    expect(result.errorCodes).toEqual(['verification-unreachable'])
    fetchSpy.mockRestore()
  })

  it('fails closed on a non-200 from siteverify', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 502 }))
    const result = await new CloudflareTurnstile({ secretKey: 'sk' }).verify('t')
    expect(result).toEqual({ success: false, errorCodes: ['http-502'] })
    fetchSpy.mockRestore()
  })
})

describe('MockTurnstile', () => {
  it('records what it was asked to verify', async () => {
    const mock = new MockTurnstile()
    await mock.verify('tok', '1.2.3.4')
    expect(mock.verified).toEqual([{ token: 'tok', remoteIp: '1.2.3.4' }])
  })

  it('can reject once and then accept', async () => {
    const mock = new MockTurnstile().rejectOnce()
    expect((await mock.verify('a')).success).toBe(false)
    expect((await mock.verify('b')).success).toBe(true)
  })
})
