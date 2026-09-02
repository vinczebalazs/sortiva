import { beforeEach, describe, expect, it } from 'vitest'
import { EmailSendFailure, type EmailMessage, type EmailProvider } from '../contracts/email'
import type { NotificationType } from '../contracts/opportunities'
import { noticeContent } from './notice'
import { idempotencyKeyFor, sendQueuedEmail } from './send'
import type {
  EmailAssembler,
  EmailRenderer,
  EmailSendDeps,
  EmailSendRecord,
  EmailStore,
} from './ports'

/**
 * The send worker against fakes. The point of every case here is what happens
 * when the same row arrives twice or the vendor misbehaves — the ordinary
 * success path is the least interesting line in the file.
 */

class FakeStore implements EmailStore {
  rows = new Map<string, EmailSendRecord>()
  suppressed = new Set<string>()
  addresses = new Map<string, string>()

  async queue(): Promise<EmailSendRecord | undefined> {
    throw new Error('not used here')
  }
  async get(id: string) {
    return this.rows.get(id)
  }
  async listQueued() {
    return [...this.rows.values()].filter((r) => r.state === 'queued')
  }
  private settle(id: string, state: EmailSendRecord['state']): boolean {
    const row = this.rows.get(id)
    if (!row || row.state !== 'queued') return false
    this.rows.set(id, { ...row, state })
    return true
  }
  async markSent(id: string) {
    return this.settle(id, 'sent')
  }
  async markFailed(id: string) {
    return this.settle(id, 'failed')
  }
  async markSuppressed(id: string) {
    return this.settle(id, 'suppressed')
  }
  async accountEmail(accountId: string) {
    return this.addresses.get(accountId)
  }
  async isSuppressed(address: string) {
    return this.suppressed.has(address)
  }
  async suppress(address: string) {
    this.suppressed.add(address)
  }
  async preferences() {
    return undefined
  }
  async savePreferences() {}
}

class RecordingProvider implements EmailProvider {
  sent: EmailMessage[] = []
  failures: EmailSendFailure[] = []
  async send(message: EmailMessage) {
    const failure = this.failures.shift()
    if (failure) throw failure
    this.sent.push(message)
    return { providerMessageId: `msg-${this.sent.length}` }
  }
}

const renderer: EmailRenderer = {
  render: (content) => ({
    subject: `[${content.subject.key}]`,
    html: `<p>${content.heading.key}</p>`,
    text: content.heading.key,
  }),
}

const assembler: EmailAssembler = {
  assemble: async (record) =>
    noticeContent(record.type as Exclude<NotificationType, 'monthly_summary_ready'>, {}, {
      actionUrl: 'https://sortiva.app/dashboard',
      unsubscribeUrl: 'https://sortiva.app/api/notifications/unsubscribe?token=tok',
    }),
}

let store: FakeStore
let provider: RecordingProvider
let deps: EmailSendDeps

const ROW: EmailSendRecord = {
  id: 'send-1',
  accountId: 'acc-1',
  type: 'payment_failed',
  dedupeKey: 'sub-1:past_due',
  templateVersion: 'notice.v1',
  state: 'queued',
}

beforeEach(() => {
  store = new FakeStore()
  provider = new RecordingProvider()
  store.rows.set(ROW.id, ROW)
  store.addresses.set('acc-1', 'merchant@example.com')
  deps = { store, provider, renderer, assembler }
})

const once = { attempt: 1, maxAttempts: 4 }

describe('sending one queued email', () => {
  it('sends it and records the provider’s id', async () => {
    const outcome = await sendQueuedEmail(deps, ROW.id, once)
    expect(outcome).toEqual({ status: 'sent', providerMessageId: 'msg-1' })
    expect(store.rows.get(ROW.id)?.state).toBe('sent')
    expect(provider.sent[0]?.to).toBe('merchant@example.com')
  })

  it('hands the vendor our own unique triple as its idempotency key', async () => {
    // Our unique index stops a second row; this stops a second *send* when the
    // vendor answered and we failed to write the answer down.
    await sendQueuedEmail(deps, ROW.id, once)
    expect(provider.sent[0]?.idempotencyKey).toBe('acc-1:payment_failed:sub-1:past_due')
    expect(idempotencyKeyFor(ROW)).toBe(provider.sent[0]?.idempotencyKey)
  })

  it('does nothing the second time the same row is delivered', async () => {
    await sendQueuedEmail(deps, ROW.id, once)
    expect(await sendQueuedEmail(deps, ROW.id, once)).toEqual({ status: 'already_settled' })
    expect(provider.sent).toHaveLength(1)
  })

  it('records a suppressed address instead of mailing it', async () => {
    store.suppressed.add('merchant@example.com')
    expect(await sendQueuedEmail(deps, ROW.id, once)).toEqual({ status: 'suppressed' })
    expect(store.rows.get(ROW.id)?.state).toBe('suppressed')
    expect(provider.sent).toHaveLength(0)
  })

  it('gives up when the account has no address left', async () => {
    store.addresses.delete('acc-1')
    expect(await sendQueuedEmail(deps, ROW.id, once)).toEqual({
      status: 'abandoned',
      reason: 'no_address',
    })
    expect(store.rows.get(ROW.id)?.state).toBe('failed')
  })

  it('asks for another attempt on a vendor fault, and the row stays queued', async () => {
    provider.failures.push(new EmailSendFailure(true, 'email_rate_limit_exceeded', 'slow down'))
    const outcome = await sendQueuedEmail(deps, ROW.id, once)
    expect(outcome).toMatchObject({ status: 'retry', attempt: 2 })
    expect(store.rows.get(ROW.id)?.state).toBe('queued')
  })

  it('dead-letters once the attempts are spent', async () => {
    provider.failures.push(new EmailSendFailure(true, 'email_rate_limit_exceeded', 'slow down'))
    const outcome = await sendQueuedEmail(deps, ROW.id, { attempt: 4, maxAttempts: 4 })
    expect(outcome).toMatchObject({ status: 'dead_letter', errorClass: 'email_rate_limit_exceeded' })
    expect(store.rows.get(ROW.id)?.state).toBe('failed')
  })

  it('dead-letters a rejected address immediately, without spending attempts', async () => {
    provider.failures.push(new EmailSendFailure(false, 'email_validation_error', 'bad address'))
    expect(await sendQueuedEmail(deps, ROW.id, once)).toMatchObject({ status: 'dead_letter' })
  })

  it('treats an unrecognised failure as worth retrying', async () => {
    provider.failures.push(new EmailSendFailure(true, 'x', 'x'))
    provider.failures[0] = Object.assign(new Error('socket hang up'), {}) as never
    expect(await sendQueuedEmail(deps, ROW.id, once)).toMatchObject({
      status: 'retry',
      errorClass: 'email_unknown',
    })
  })

  it('carries the one-click unsubscribe headers only where the kind allows it', async () => {
    await sendQueuedEmail(deps, ROW.id, once)
    // Payment failed is not toggleable, so it carries no unsubscribe.
    expect(provider.sent[0]?.headers).toBeUndefined()

    const summary: EmailSendRecord = { ...ROW, id: 'send-2', type: 'article_published', dedupeKey: 'art-1' }
    store.rows.set(summary.id, summary)
    await sendQueuedEmail(deps, summary.id, once)
    expect(provider.sent[1]?.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })
})
