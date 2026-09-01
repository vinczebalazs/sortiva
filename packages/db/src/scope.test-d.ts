/**
 * T0.3 done-when: "a repository call without scope fails to compile."
 *
 * This file is the proof, and it is checked by `pnpm typecheck`, not by vitest:
 * every `@ts-expect-error` below must correspond to a real type error. If one of
 * these calls ever starts compiling, `tsc` reports "Unused '@ts-expect-error'
 * directive" and the build fails — so the guarantee cannot rot silently.
 *
 * Nothing here runs; the file exports a function that is never called.
 */
import type { Db } from './client'
import { insertDomainRow, findDomainForAccount, transitionDomainState } from './repositories/domains'
import { emitNotification, queueEmail } from './repositories/notifications'
import { isAccountFlagActive, recordWebhookEvent } from './repositories/system'
import { accountScope, systemScope } from './scope'

export async function proofs(db: Db): Promise<void> {
  const scope = accountScope('11111111-1111-1111-1111-111111111111')
  const system = systemScope('webhook receipt, before the account is resolved')

  // ── The supported calls type-check. ────────────────────────────────────────
  await insertDomainRow(db, scope, 'example.com')
  await findDomainForAccount(db, scope)
  await transitionDomainState(db, scope, 'ingesting', 'needs_confirmation')
  await emitNotification(db, scope, { type: 'article_published', dedupeKey: 'a1' })
  await queueEmail(db, scope, {
    type: 'article_published',
    dedupeKey: 'a1',
    templateVersion: 'v1',
  })
  await isAccountFlagActive(db, scope, 'account.pause_generation')
  await recordWebhookEvent(db, system, {
    webhookId: 'w1',
    source: 'shopify',
    topic: 'products/update',
    payload: {},
  })

  // ── Omitting the scope entirely. ───────────────────────────────────────────
  // @ts-expect-error scope is required
  await insertDomainRow(db, 'example.com')
  // @ts-expect-error scope is required
  await findDomainForAccount(db)
  // @ts-expect-error scope is required
  await emitNotification(db, { type: 'article_published', dedupeKey: 'a1' })

  // ── Passing a bare account id instead of a scope. This is the case that ────
  // ── matters: a raw string is exactly what a request body would supply, ─────
  // ── and account_id must never come from there. ─────────────────────────────
  // @ts-expect-error a raw account id is not an AccountScope
  await insertDomainRow(db, '11111111-1111-1111-1111-111111111111', 'example.com')
  // @ts-expect-error a structurally-similar object is not an AccountScope
  await findDomainForAccount(db, { accountId: '11111111-1111-1111-1111-111111111111' })

  // ── A system scope is not an account scope, and vice versa. ────────────────
  // @ts-expect-error SystemScope cannot stand in for AccountScope
  await findDomainForAccount(db, system)
  // @ts-expect-error AccountScope cannot stand in for SystemScope
  await recordWebhookEvent(db, scope, {
    webhookId: 'w1',
    source: 'shopify',
    topic: 'products/update',
    payload: {},
  })
}
