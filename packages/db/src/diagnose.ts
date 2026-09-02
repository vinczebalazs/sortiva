import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { normaliseClaimDomain } from '@sortiva/core'
import type { Db } from './client'
import * as schema from './schema'
import {
  accounts,
  domains,
  gscConns,
  ingestionJobs,
  jobDlq,
  jobSteps,
  shopifyConns,
  subscriptions,
} from './schema'
import { systemScope, type SystemScope } from './scope'

/**
 * **"Why is this store stuck?", answered without writing SQL by hand.**
 *
 * Support arrives knowing one of two things about a merchant: the address they
 * signed up with, or the website they connected. Everything an operator then
 * wants — is the store connected, did onboarding start, which of its nine steps
 * has not finished, what did the failing one say — lives across six tables that
 * have to be joined in the right order. Doing that by hand at the moment
 * somebody is waiting is how a wrong answer gets given confidently.
 *
 * Reads only. Nothing here writes, enqueues or retries.
 *
 * Takes a `SystemScope` for the same reason every other unscoped read does: the
 * whole point is to *find* the account, so it cannot be handed one. The scope's
 * reason is what makes that deliberate rather than an omission.
 */

export type StoreSelector = { readonly email: string } | { readonly domain: string }

export interface DiagnosedStep {
  readonly step: string
  readonly state: string
  readonly attempts: number
  readonly lastError: string | null
  readonly nextAttemptAt: Date | null
  readonly startedAt: Date | null
  readonly updatedAt: Date
  /** True when the step saved a position it can resume from. */
  readonly hasCheckpoint: boolean
}

export interface DiagnosedRun {
  readonly runId: string
  readonly status: string
  readonly startedAt: Date
  readonly finishedAt: Date | null
  readonly steps: readonly DiagnosedStep[]
}

export interface DiagnosedDlqEntry {
  readonly id: string
  readonly step: string
  readonly errorClass: string
  readonly lastError: string
  readonly attempts: number
  readonly firstFailedAt: Date
}

export interface StoreDiagnosis {
  readonly accountId: string
  readonly email: string
  readonly createdAt: Date
  readonly deletedAt: Date | null
  readonly domain: {
    readonly normalized: string
    readonly state: string
    readonly platform: string | null
    readonly claimedAt: Date
    readonly releaseAfter: Date | null
  } | null
  readonly subscriptionStatus: string | null
  readonly shopify: { readonly shopHandle: string; readonly grantedScopes: readonly string[]; readonly connectedAt: Date; readonly invalidatedAt: Date | null } | null
  readonly searchConsole: { readonly property: string; readonly connectedAt: Date; readonly invalidatedAt: Date | null } | null
  readonly runs: readonly DiagnosedRun[]
  /** Work that failed for good and is waiting for somebody to replay it. */
  readonly openDeadLetters: readonly DiagnosedDlqEntry[]
}

/** Why this read names no account: finding the account is what it is for. */
export const diagnosisScope = (): SystemScope =>
  systemScope('an operator is looking a store up by email or domain — finding the account is the point')

/**
 * @returns the store's state and every pipeline step, or `null` when no such
 * store exists — which the caller must say plainly rather than printing an
 * empty report that looks like a healthy store with nothing to show.
 */
export async function diagnoseStore(
  db: Db,
  _scope: SystemScope,
  selector: StoreSelector,
): Promise<StoreDiagnosis | null> {
  const account = await findAccount(db, selector)
  if (!account) return null

  const [domain] = await db.select().from(domains).where(eq(domains.accountId, account.id)).limit(1)
  const [subscription] = await db
    .select({ status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.accountId, account.id))
    .limit(1)
  const [shopify] = await db
    .select()
    .from(shopifyConns)
    .where(eq(shopifyConns.accountId, account.id))
    .limit(1)
  const [gsc] = await db.select().from(gscConns).where(eq(gscConns.accountId, account.id)).limit(1)

  const runRows = await db
    .select()
    .from(ingestionJobs)
    .where(eq(ingestionJobs.accountId, account.id))
    .orderBy(desc(ingestionJobs.startedAt))

  const runs: DiagnosedRun[] = []
  for (const run of runRows) {
    const steps = await db
      .select()
      .from(jobSteps)
      .where(eq(jobSteps.jobId, run.id))
      // By when each step was last touched, which is the order somebody reading
      // a stuck run wants: what moved last is where it stopped.
      .orderBy(asc(jobSteps.updatedAt), asc(jobSteps.step))
    runs.push({
      runId: run.runId,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      steps: steps.map((step) => ({
        step: step.step,
        state: step.state,
        attempts: step.attempts,
        lastError: step.lastError,
        nextAttemptAt: step.nextAttemptAt,
        startedAt: step.startedAt,
        updatedAt: step.updatedAt,
        hasCheckpoint: step.checkpoint !== null && step.checkpoint !== undefined,
      })),
    })
  }

  const deadLetters = await db
    .select()
    .from(jobDlq)
    .where(and(eq(jobDlq.accountId, account.id), isNull(jobDlq.replayedAt)))
    .orderBy(desc(jobDlq.createdAt))

  return {
    accountId: account.id,
    email: account.email,
    createdAt: account.createdAt,
    deletedAt: account.deletedAt,
    domain: domain
      ? {
          normalized: domain.domainNormalized,
          state: domain.state,
          platform: domain.platform,
          claimedAt: domain.claimedAt,
          releaseAfter: domain.releaseAfter,
        }
      : null,
    subscriptionStatus: subscription?.status ?? null,
    shopify: shopify
      ? {
          shopHandle: shopify.shopHandle,
          grantedScopes: shopify.grantedScopes,
          connectedAt: shopify.connectedAt,
          invalidatedAt: shopify.invalidatedAt,
        }
      : null,
    searchConsole: gsc
      ? { property: gsc.property, connectedAt: gsc.connectedAt, invalidatedAt: gsc.invalidatedAt }
      : null,
    runs,
    openDeadLetters: deadLetters.map((entry) => ({
      id: entry.id,
      step: entry.step,
      errorClass: entry.errorClass,
      lastError: entry.lastError,
      attempts: entry.attempts,
      firstFailedAt: entry.firstFailedAt,
    })),
  }
}

async function findAccount(db: Db, selector: StoreSelector) {
  if ('email' in selector) {
    const [row] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.email, selector.email.trim().toLowerCase()))
      .limit(1)
    return row
  }

  // Through the same normaliser the claim used, so an operator can paste
  // whatever the merchant sent them — a URL, a `www.` host, mixed case — and
  // still land on the row the unique index is keyed by.
  const { normalized } = normaliseClaimDomain(selector.domain)
  const [row] = await db
    .select({
      id: accounts.id,
      email: accounts.email,
      createdAt: accounts.createdAt,
      deletedAt: accounts.deletedAt,
    })
    .from(domains)
    .innerJoin(accounts, eq(domains.accountId, accounts.id))
    .where(eq(domains.domainNormalized, normalized))
    .limit(1)
  return row
}

/**
 * The same read, for a caller that has a connection string rather than a
 * handle — which is what a command-line script has.
 */
export async function diagnoseStoreAt(
  selector: StoreSelector,
  connectionString = process.env.DATABASE_URL,
): Promise<StoreDiagnosis | null> {
  if (!connectionString) throw new Error('DATABASE_URL is not set')
  const pool = new pg.Pool({ connectionString })
  try {
    return await diagnoseStore(drizzle(pool, { schema }), diagnosisScope(), selector)
  } finally {
    await pool.end()
  }
}
