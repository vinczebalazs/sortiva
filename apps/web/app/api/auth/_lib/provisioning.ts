import { createOrFindAccountByEmail, db, systemScope, type Db } from '@sortiva/db'
import type { AccountStore, ProvisionAccountDeps } from '@sortiva/core'
import { PosthogServerCapture } from '@sortiva/providers'

/**
 * The composition root for signup: the one place `packages/core`'s account port
 * meets the database and PostHog. Core owns no persistence (CLAUDE.md
 * code-structure rules), so this binding lives in `apps/web`.
 */

const SIGNUP_SCOPE_REASON = 'signup: the account being created is the one being resolved'

export function makeDbAccountStore(injectedDatabase?: Db): AccountStore {
  return {
    async createOrFindByEmail(email: string) {
      const { account, created } = await createOrFindAccountByEmail(
        injectedDatabase ?? db(),
        systemScope(SIGNUP_SCOPE_REASON),
        email,
      )
      return { accountId: account.id, created }
    },
  }
}

export const dbAccountStore = makeDbAccountStore()

let capture: PosthogServerCapture | undefined

/** main §14.7 — `signup_completed` is a funnel event, captured server-side. */
export function provisioningDeps(): ProvisionAccountDeps {
  capture ??= new PosthogServerCapture()
  return { store: dbAccountStore, capture }
}
