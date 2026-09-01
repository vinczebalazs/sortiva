import { describe, expect, it, vi } from 'vitest'
import { EmailSendFailure, type EmailMessage } from '@sortiva/core'
import { MockEmailProvider, ResendEmailProvider } from './index'

/** The send path, its idempotency key, and its failure classes. */

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    to: 'merchant@example.com',
    subject: 'Your first opportunities are ready',
    html: '<p>hello</p>',
    idempotencyKey: 'acc-1:opportunities_ready:run-9',
    templateVersion: 'opportunities_ready.v1',
    ...overrides,
  }
}

describe('ResendEmailProvider', () => {
  it('sends our (account, type, dedupe_key) triple as the provider idempotency key', async () => {
    const send = vi.fn(async () => ({ data: { id: 'resend-1' }, error: null }))
    const provider = new ResendEmailProvider({
      client: { emails: { send } } as never,
      from: 'Sortiva <hello@mail.example.com>',
    })

    const result = await provider.send(message({ headers: { 'List-Unsubscribe': '<https://x>' } }))

    expect(result.providerMessageId).toBe('resend-1')
    const [payload, options] = send.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { idempotencyKey: string },
    ]
    expect(options.idempotencyKey).toBe('acc-1:opportunities_ready:run-9')
    expect(payload.from).toBe('Sortiva <hello@mail.example.com>')
    expect(payload.headers).toEqual({ 'List-Unsubscribe': '<https://x>' })
  })

  it('classifies a rate limit as retryable and a rejected address as terminal', async () => {
    const rateLimited = new ResendEmailProvider({
      client: {
        emails: { send: async () => ({ data: null, error: { name: 'rate_limit_exceeded', message: 'slow down' } }) },
      } as never,
      from: 'a@b.com',
    })
    await expect(rateLimited.send(message())).rejects.toMatchObject({ retryable: true })

    const rejected = new ResendEmailProvider({
      client: {
        emails: { send: async () => ({ data: null, error: { name: 'validation_error', message: 'bad address' } }) },
      } as never,
      from: 'a@b.com',
    })
    await expect(rejected.send(message())).rejects.toMatchObject({
      retryable: false,
      errorClass: 'email_validation_error',
    })
  })

  it('refuses to construct without a verified sender', () => {
    expect(() => new ResendEmailProvider({ client: {} as never, from: '' })).toThrow(/EMAIL_FROM/)
  })
})

describe('MockEmailProvider', () => {
  it('returns the first result for a repeated idempotency key, never a second send', async () => {
    const provider = new MockEmailProvider()

    const first = await provider.send(message())
    const second = await provider.send(message({ subject: 'a later edit of the same send' }))

    expect(second.providerMessageId).toBe(first.providerMessageId)
    expect(provider.sent).toHaveLength(1)
  })

  it('drives the retry path on demand', async () => {
    const provider = new MockEmailProvider()
    provider.failNext(new EmailSendFailure(true, 'email_rate_limit_exceeded', 'slow down'))

    await expect(provider.send(message())).rejects.toBeInstanceOf(EmailSendFailure)
    // The retry succeeds; the failed attempt left nothing behind.
    await provider.send(message())
    expect(provider.to('merchant@example.com')).toHaveLength(1)
  })
})
