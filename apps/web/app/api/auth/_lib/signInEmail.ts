import { createHash } from 'node:crypto'
import type { EmailMessage, EmailProvider } from '@sortiva/core'

/**
 * The email that carries a sign-in link.
 *
 * **Where this copy lives, and why it is not in `packages/ui/strings`.** That
 * file holds screen copy and belongs to the frontend lane; nothing in the repo
 * sends an email with words in it yet, and the card that builds the email
 * pipeline (`T8.2`) is choosing where template copy lives. Putting four strings
 * into a screen's dictionary now would pre-empt that choice in a file another
 * lane is editing. Recorded in DECISIONS 2026-09-02 T-EMAIL.
 *
 * **Why this does not go through the email queue.** The queue writes an
 * `email_sends` row keyed on `(account_id, type, dedupe_key)`, and the person
 * asking for a sign-in link may have no account yet — that is the whole point
 * of the link. Dedupe would also be wrong here: asking for a second link
 * because the first one is stale has to send a second email. So this goes
 * straight through the `EmailProvider` wrapper, which is what invariant 25
 * actually requires, and the vendor's idempotency key is scoped to the one link
 * rather than to a repeatable notification.
 */

export const SIGN_IN_EMAIL_TEMPLATE_VERSION = 'auth.signin-link.v1'

/** Minutes, phrased for the reader; keep in step with `SIGN_IN_LINK_MAX_AGE_SECONDS`. */
export interface SignInEmailInput {
  readonly to: string
  readonly url: string
  readonly validForMinutes: number
  /** The raw link secret. Used only to key the send; never written anywhere. */
  readonly token: string
}

/**
 * Keying the send on the link itself means a retry of the same send cannot
 * deliver twice, while a genuinely new link is a genuinely new email. The
 * secret is hashed rather than passed through: the vendor already receives the
 * link in the body, and there is no reason to also make it a header they log.
 */
function idempotencyKeyFor(token: string): string {
  return `auth:signin-link:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function buildSignInEmail(input: SignInEmailInput): EmailMessage {
  const href = escapeHtml(input.url)
  const minutes = input.validForMinutes

  const text = [
    'Sign in to Sortiva',
    '',
    'Open this link to sign in:',
    input.url,
    '',
    `The link works once and expires in ${minutes} minutes.`,
    'If you did not ask to sign in, you can ignore this email — nothing has changed.',
  ].join('\n')

  const html = [
    '<p>Sign in to Sortiva</p>',
    `<p><a href="${href}">Open this link to sign in</a></p>`,
    `<p>The link works once and expires in ${minutes} minutes.</p>`,
    '<p>If you did not ask to sign in, you can ignore this email — nothing has changed.</p>',
    `<p>${href}</p>`,
  ].join('\n')

  return {
    to: input.to,
    subject: 'Your Sortiva sign-in link',
    html,
    text,
    idempotencyKey: idempotencyKeyFor(input.token),
    templateVersion: SIGN_IN_EMAIL_TEMPLATE_VERSION,
  }
}

/** What `config.ts` calls when Auth.js has a link to deliver. */
export type SendSignInLink = (input: SignInEmailInput) => Promise<void>

export function sendSignInLinkVia(provider: () => EmailProvider): SendSignInLink {
  return async (input) => {
    await provider().send(buildSignInEmail(input))
  }
}
