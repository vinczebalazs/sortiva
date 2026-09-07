import { and, eq, isNotNull, lte, sql } from 'drizzle-orm'
import { db, schema, type Database } from '@sortiva/db'
// Deep import, not the package barrel: `@sortiva/jobs`'s index re-exports the
// Graphile Worker runtime, which would drag the worker library into every
// request bundle that touches this file. `steps.ts` imports only drizzle.
import { createRun } from '@sortiva/jobs/runtime/steps'
// Same reason again: `queue.ts` imports drizzle and nothing else, so asking for
// the work does not pull the code that performs it into this request bundle.
import { enqueueIngestionDispatch } from '@sortiva/jobs/ingestion/queue'
import type { ClaimRequest, DomainClaimStore, StoreClaimResult } from '@sortiva/core'

/**
 * The composition root for the domain claim: where `packages/core`'s claim port
 * meets Postgres. Core owns no persistence (constitution code-structure rules),
 * so — exactly as T1.1 bound the account port and T1.2 the billing ports — the
 * binding lives in `apps/web`.
 *
 * These queries belong in `packages/db/src/repositories/domains.ts` beside
 * `claimDomain`, which T0.3 already wrote there and which this replaces. That
 * package was held by a concurrent session for the whole of this card and could
 * not be edited; moving it is a mechanical follow-up. See DECISIONS 2026-09-01
 * T1.4.
 */

const { domains, ingestionJobs } = schema

export interface DomainClaimStoreOptions {
  /** The integration test hands in its own isolated database. */
  database?: Database
}

export function makeDomainClaimStore(options: DomainClaimStoreOptions = {}): DomainClaimStore {
  const database = options.database ?? db()

  return {
    async claimWithIngestionRun(request: ClaimRequest): Promise<StoreClaimResult> {
      return database.transaction(
        async (tx) => {
          // A domain whose previous owner deleted their account is held for a
          // week and then belongs to nobody. That deadline is written on the
          // row at deletion time, so it can be honoured by whoever needs it —
          // and it is honoured here, at the moment somebody actually tries to
          // claim the domain, rather than only by the nightly sweep. Without
          // this the hold is exactly as reliable as that sweep: if it never
          // runs, the row never goes and the domain is blocked for ever, which
          // is safe but is not the week we promised.
          //
          // Deliberately a delete before the insert rather than a conditional
          // upsert on the conflicting row: the insert below stays exactly as it
          // was, so the unique index and nothing else still decides who wins.
          // Two claims racing for the same released domain both reach that
          // insert and one of them loses there. A row with no deadline never
          // matches, so a live account's domain is untouchable here.
          await tx
            .delete(domains)
            .where(
              and(
                eq(domains.domainNormalized, request.normalized),
                isNotNull(domains.releaseAfter),
                // The database's clock, not the web process's, so two servers
                // disagreeing about the time cannot disagree about the deadline.
                lte(domains.releaseAfter, sql`now()`),
              ),
            )

          // Insert against the unique index and catch
          // the conflict. Nothing reads the table to decide whether to insert,
          // so there is no window between the check and the write.
          const [inserted] = await tx
            .insert(domains)
            .values({ accountId: request.accountId, domainNormalized: request.normalized })
            .onConflictDoNothing()
            .returning()

          if (inserted) {
            // The claim, its ingestion run and the request to start that run
            // all commit together, so a claim can never land without work
            // behind it and a nudge can never outlive a claim that rolled
            // back. Find-or-create rather than create: the run id is derived
            // from the domain, so an account re-claiming a domain whose row was
            // released after deletion would otherwise collide with its own old
            // run.
            const jobId = await startRun(tx, request)
            return { kind: 'claimed', state: inserted.state, ingestionJobId: jobId }
          }

          // Which of the two unique indexes rejected us is read back here, in
          // the same transaction as the failed insert. Under `read committed`
          // each statement takes a fresh snapshot, so a claim that was still
          // uncommitted when our insert blocked on it is visible to this read —
          // which is what makes the loser of a race able to say *why* it lost.
          // A stricter isolation level would break exactly that, so it is
          // pinned below rather than left to the connection default.
          const [byDomain] = await tx
            .select()
            .from(domains)
            .where(eq(domains.domainNormalized, request.normalized))
            .limit(1)

          if (byDomain && byDomain.accountId === request.accountId) {
            // Already this account's domain: a no-op, and the caller
            // redirects. The run is found rather than created; it is created
            // only if the claim somehow committed without one, which keeps the
            // response's `ingestionJobId` answerable on every path. It is asked
            // to move again, which is how a merchant who re-submits the form
            // after a stall gets going without anyone touching the database.
            const jobId = await startRun(tx, request)
            return { kind: 'already_yours', state: byDomain.state, ingestionJobId: jobId }
          }

          if (byDomain) return { kind: 'taken_by_other' }

          const [byAccount] = await tx
            .select()
            .from(domains)
            .where(eq(domains.accountId, request.accountId))
            .limit(1)

          if (byAccount) {
            return { kind: 'account_has_other_domain', current: byAccount.domainNormalized }
          }

          // Neither index explains the conflict: the row that beat us was
          // rolled back between the insert and the read. Aborting lets the
          // caller retry into a clean world rather than answer from a guess.
          throw new ClaimConflictVanished(request.normalized)
        },
        { isolationLevel: 'read committed' },
      )
    },
  }
}

export class ClaimConflictVanished extends Error {
  constructor(readonly normalized: string) {
    super(`The claim on ${normalized} conflicted with a row that no longer exists.`)
    this.name = 'ClaimConflictVanished'
  }
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * The store's onboarding run, and the request for a worker to start moving it.
 *
 * Both halves are needed. The run and its nine step rows are the durable record
 * — what the progress screen draws and what a worker resumes from after a
 * crash. The queued job is what makes anything happen at all: without it the
 * steps sit untouched until a person does something else, which is the state
 * the product was actually in.
 *
 * Queued inside the caller's transaction, deliberately: a job asking for a run
 * that never committed would fail forever, and a claim that committed with no
 * job leaves the merchant watching a progress screen nothing will advance.
 */
async function startRun(tx: Tx, request: ClaimRequest): Promise<string> {
  const jobId = await findOrCreateRun(tx, request)
  await enqueueIngestionDispatch(tx, { accountId: request.accountId, jobId })
  return jobId
}

async function findOrCreateRun(tx: Tx, request: ClaimRequest): Promise<string> {
  const [existing] = await tx
    .select({ id: ingestionJobs.id })
    .from(ingestionJobs)
    .where(
      and(
        eq(ingestionJobs.accountId, request.accountId),
        eq(ingestionJobs.runId, request.runId),
      ),
    )
    .limit(1)
  if (existing) return existing.id
  const { jobId } = await createRun(tx, request.accountId, request.runId)
  return jobId
}
