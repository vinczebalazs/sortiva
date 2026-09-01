import {
  claimDomain,
  claimDomainRequestSchema,
  type ClaimDomainDeps,
  type ClaimDomainResult,
} from '@sortiva/core'
import type { AccountHandler } from '../../auth/_lib/session'
import { claimDeps } from './config'

/**
 * `POST /api/domain/claim` — main §5, ui §3.1. Parse → call core → serialise,
 * and nothing else: normalisation, the transactional claim and the ingestion
 * enqueue all live behind `claimDomain`.
 *
 * The account comes from the session, never from the body (tech §3) — which is
 * also what makes "already claimed by this account" answerable at all.
 */

export interface ClaimHandlerOptions {
  /** Injected by the integration test; production wires the real store. */
  deps?: ClaimDomainDeps
}

export function makeClaimHandler(options: ClaimHandlerOptions = {}): AccountHandler {
  return async (request, { scope }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return error(422, 'invalid_body', 'Expected a JSON body.')
    }

    const parsed = claimDomainRequestSchema.safeParse(body)
    if (!parsed.success) {
      return Response.json(
        {
          error: {
            code: 'invalid_body',
            message: 'Enter your store address.',
            details: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        },
        { status: 422 },
      )
    }

    const result = await claimDomain(options.deps ?? claimDeps(), {
      accountId: scope.accountId,
      domain: parsed.data.domain,
    })

    return serialise(result)
  }
}

function serialise(result: ClaimDomainResult): Response {
  switch (result.kind) {
    // main §5 — a returning merchant re-pasting their own domain gets the same
    // 200 as the merchant who just claimed it, so the client's next move is the
    // same redirect to the progress screen either way.
    case 'claimed':
    case 'already_yours':
      return Response.json(
        {
          normalized: result.normalized,
          state: result.state,
          ingestionJobId: result.ingestionJobId,
        },
        { status: 200 },
      )
    case 'taken_by_other':
      // tech §3 — a guarded transition that lost returns 409 with the
      // machine-readable code the UI maps to its copy.
      return error(409, 'domain_already_claimed', result.message)
    case 'account_has_other_domain':
      // Not a 409: `domain_already_claimed` is a closed enum of codes the UI
      // maps to specific copy, and telling this merchant their own domain
      // belongs to someone else would send them to support with the wrong
      // story. See DECISIONS 2026-09-01 T1.4.
      return error(422, 'account_has_other_domain', result.message)
    case 'invalid_domain':
      return error(422, 'invalid_domain', result.message)
  }
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}

export const claimHandler = makeClaimHandler()
