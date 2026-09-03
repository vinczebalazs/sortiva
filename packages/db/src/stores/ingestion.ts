import { db, type Db } from '../client'
import { findLatestIngestionRun, listJobStepsForRun, type JobStepRow } from '../repositories/runs'
import type { AccountScope } from '../scope'

/**
 * The one read the progress screen (ui §3.2) and its SSE stream both make:
 * this account's most recent onboarding run and every step of it.
 *
 * A route handler is called by its framework and cannot hold a database
 * handle of its own — the lint rule that keeps queries scoped to an account
 * forbids it outside this package — so this is the port both `/api/ingestion/status`
 * and its SSE sibling take.
 */

export interface IngestionRunView {
  readonly jobId: string
  readonly status: 'running' | 'succeeded' | 'failed' | 'abandoned'
  readonly startedAt: Date
  readonly steps: readonly JobStepRow[]
}

export interface IngestionStatusStoreOptions {
  /** An integration test hands in its own isolated database; production uses the pool. */
  database?: Db
}

export interface IngestionStatusStore {
  /** Undefined when this account has never claimed a domain — there is no run to show. */
  latestRun(scope: AccountScope): Promise<IngestionRunView | undefined>
}

export function makeIngestionStatusStore(
  options: IngestionStatusStoreOptions = {},
): IngestionStatusStore {
  const database = (): Db => options.database ?? db()

  return {
    async latestRun(scope) {
      const run = await findLatestIngestionRun(database(), scope)
      if (!run) return undefined
      const steps = await listJobStepsForRun(database(), run.id)
      return { jobId: run.id, status: run.status, startedAt: run.startedAt, steps }
    },
  }
}
