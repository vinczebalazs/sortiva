import { MockEmailProvider, ResendEmailProvider } from '@sortiva/providers'
import type { EmailProvider } from '@sortiva/core'

/**
 * Which email provider this process talks to.
 *
 * Without credentials it is the test double — which records what would have
 * been sent and enforces the same idempotency contract — rather than a client
 * that throws on construction. A developer running the app locally should get a
 * working pipeline and an empty outbox, not a worker that dies at startup.
 *
 * Production has the key, so it gets Resend. There is no flag: the presence of
 * the credential is the switch, exactly as it is for the search-data provider.
 */
let provider: EmailProvider | undefined

export function emailProvider(): EmailProvider {
  if (provider) return provider
  const configured = Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM)
  provider = configured ? new ResendEmailProvider() : new MockEmailProvider()
  if (!configured) {
    console.warn(
      '[email] RESEND_API_KEY or EMAIL_FROM is unset — queued mail will be recorded and not sent.',
    )
  }
  return provider
}

/** Test-only: the provider is a module singleton and so is this latch. */
export function resetEmailProvider(): void {
  provider = undefined
}
