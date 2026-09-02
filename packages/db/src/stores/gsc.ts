import type { GscConnectStore, GscConnectionRecord } from '@sortiva/core'
import { db, type Db } from '../client'
import { accountScope } from '../scope'
import { findDomainForAccount } from '../repositories/domains'
import {
  findActiveIngestionRun,
  transitionAccountJobStep,
  type JobStepRow,
} from '../repositories/runs'
import {
  findGscConnForAccount,
  saveGscGrant,
  selectGscProperty,
} from '../repositories/search'

/**
 * Binds the Search Console connect flow to this deployment's database.
 *
 * It lives here, next to the queries, rather than in the web app, because it is
 * the only thing in the flow that needs a database handle at all — and a handle
 * outside this package is how a query ends up running without naming the store
 * it is for. Everything above this is handed a port.
 *
 * The two onboarding-step moves are guarded, and a guard that matches nothing is
 * silence rather than an error on purpose: a merchant answering the Search
 * Console question after the run has moved past it has answered a question
 * nobody is asking any more, and their answer to the *connection* — the part
 * that matters — has already been written.
 */

export interface GscConnectStoreOptions {
  /** An integration test hands in its own isolated database; production uses the pool. */
  database?: Db
  /**
   * Queues the one-time history import. Supplied by the caller because the queue
   * lives a layer up; it is handed this package's own database handle so no
   * caller has to hold one.
   */
  enqueueBackfill: (database: Db, accountId: string) => Promise<void>
}

const FROM_STATES: readonly JobStepRow['state'][] = ['pending', 'running', 'failed_retryable']

export function makeGscConnectStore(options: GscConnectStoreOptions): GscConnectStore {
  const database = (): Db => options.database ?? db()

  return {
    async claimedDomain(accountId) {
      const domain = await findDomainForAccount(database(), accountScope(accountId))
      return domain?.domainNormalized ?? null
    },

    async connection(accountId): Promise<GscConnectionRecord | null> {
      const row = await findGscConnForAccount(database(), accountScope(accountId))
      if (!row) return null
      return { property: row.property, tokens: row.tokens, invalidatedAt: row.invalidatedAt }
    },

    async saveGrant(accountId, tokens) {
      await saveGscGrant(database(), accountScope(accountId), { tokens })
    },

    async selectProperty(accountId, property, connectedAt) {
      const row = await selectGscProperty(database(), accountScope(accountId), {
        property,
        connectedAt,
      })
      return row !== undefined
    },

    async completeConnectStep(accountId) {
      await moveConnectStep(database(), accountId, 'succeeded')
    },

    async skipConnectStep(accountId) {
      await moveConnectStep(database(), accountId, 'skipped')
    },

    async enqueueBackfill(accountId) {
      await options.enqueueBackfill(database(), accountId)
    },
  }
}

async function moveConnectStep(
  database: Db,
  accountId: string,
  to: 'succeeded' | 'skipped',
): Promise<void> {
  const scope = accountScope(accountId)
  const run = await findActiveIngestionRun(database, scope)
  if (!run) return
  await transitionAccountJobStep(database, scope, {
    jobId: run.id,
    step: 'gsc_connect',
    from: FROM_STATES,
    to,
  })
}
