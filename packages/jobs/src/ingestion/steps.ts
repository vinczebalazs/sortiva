import {
  assertReadOnlyGrant,
  detectPlatform,
  type PlatformDetection,
} from '@sortiva/core'
import type { Db } from '@sortiva/db'
import { RetryableFailure, TerminalFailure, TokenInvalidFailure } from '../runtime/errors'
import { inputVersion } from '../runtime/idempotency'
import type { StepContext } from '../runtime/runStep'
import { findRunForAccount, findStep, type JobStepName } from '../runtime/steps'
import type { IngestionDeps } from './deps'

/**
 * The first two steps of onboarding: work out what the merchant's site runs on,
 * and wait for permission to read it.
 *
 * Each step declares three things — whether it can start yet, what its inputs
 * are (which is what its idempotency key is derived from, so a redelivery
 * recognises work already done), and what it does. The dispatcher does the rest.
 */

export interface StepDefinition {
  /**
   * A condition beyond the dependency graph. False means "not yet": the step row
   * stays untouched and the run pauses here until something makes it true.
   */
  ready?(deps: IngestionDeps, accountId: string): Promise<boolean>
  /** The inputs this run of the step is over. Never anything random. */
  inputVersion(deps: IngestionDeps, accountId: string): Promise<string>
  execute(deps: IngestionDeps, ctx: StepContext): Promise<unknown>
}

export interface DetectOutput {
  readonly platform: 'shopify' | 'custom_unsupported'
  readonly signals: readonly string[]
  readonly shopHandle?: string
}

/**
 * Step one. Fetches the claimed site, decides whether it is a Shopify store,
 * and moves the store to the screen that follows from the answer: the connect
 * prompt, or the parked card explaining that we only support Shopify.
 *
 * A Shopify store whose `*.myshopify.com` name we cannot discover fails rather
 * than guesses. The permission handshake is addressed to that name, and an
 * invented one would send the merchant to a consent screen for somebody else's
 * store.
 */
export const detectStep: StepDefinition = {
  async inputVersion(deps, accountId) {
    const domain = await requireDomain(deps, accountId)
    // The claimed site is the whole input. A store parked as unsupported stays
    // parked — there is no self-serve way out in V1 — so re-running detection
    // against the same site is meant to return the same answer.
    return inputVersion({ domain })
  },

  async execute(deps, ctx): Promise<DetectOutput> {
    const domain = await requireDomain(deps, ctx.accountId)
    const detection = await detect(deps, domain)

    ctx.log.info('detect.completed', {
      platform: detection.platform,
      signal_count: detection.signals.length,
      shop_handle_found: detection.shopHandle !== undefined,
    })

    if (detection.platform === 'custom_unsupported') {
      await deps.domains.setPlatform(ctx.accountId, 'custom_unsupported')
      await deps.domains.transition(ctx.accountId, ['ingesting'], 'unsupported')
      return { platform: 'custom_unsupported', signals: detection.signals }
    }

    if (!detection.shopHandle) {
      throw new RetryableFailure(
        'shop_handle_not_found',
        `${domain} looks like a Shopify store but does not reveal its myshopify.com name, ` +
          `which the permission handshake has to be addressed to.`,
      )
    }

    await deps.domains.setPlatform(ctx.accountId, 'shopify')
    await deps.domains.transition(ctx.accountId, ['ingesting'], 'awaiting_shopify_auth')
    return {
      platform: 'shopify',
      signals: detection.signals,
      shopHandle: detection.shopHandle,
    }
  },
}

export interface OauthWaitOutput {
  readonly shopHandle: string
  readonly shopId: number
  readonly grantedScopes: readonly string[]
}

/**
 * Step two. There is no work to do here until the merchant grants permission,
 * and no way to do it without them: reading a store's best sellers means
 * reading its orders, which is not public. So the step simply is not ready
 * until a connection exists, and the store waits on the connect screen.
 *
 * Once a connection does exist, the step confirms the token actually reads the
 * store before telling the merchant they are connected, and hands the store
 * back to the pipeline.
 */
export const oauthWaitStep: StepDefinition = {
  async ready(deps, accountId) {
    const connection = await deps.connections.read(accountId)
    return connection !== undefined && connection.invalidatedAt === null
  },

  async inputVersion(deps, accountId) {
    const connection = await deps.connections.read(accountId)
    if (!connection) throw new TerminalFailure('no_connection', 'No Shopify connection to verify.')
    // A reconnection is genuinely different work from the first connection: its
    // token is new and has to be proved to read the store on its own.
    return inputVersion({
      shop: connection.shopHandle,
      connectedAt: connection.connectedAt.toISOString(),
    })
  },

  async execute(deps, ctx): Promise<OauthWaitOutput> {
    const connection = await deps.connections.read(ctx.accountId)
    if (!connection) throw new TerminalFailure('no_connection', 'No Shopify connection to verify.')
    assertReadOnlyGrant(connection.grantedScopes)

    const token = await deps.connections.readToken(ctx.accountId)
    if (!token) {
      throw new TerminalFailure('no_connection', 'The Shopify connection holds no token.')
    }

    const shop = await withTokenInvalidRouting(() =>
      deps.shop.getShop({ shop: connection.shopHandle, accessToken: token }),
    )

    await deps.domains.transition(ctx.accountId, ['awaiting_shopify_auth'], 'ingesting')
    ctx.log.info('oauth_wait.verified', {
      shop_id: shop.id,
      granted_scope_count: connection.grantedScopes.length,
    })

    return {
      shopHandle: connection.shopHandle,
      shopId: shop.id,
      grantedScopes: connection.grantedScopes,
    }
  },
}

export const INGESTION_STEPS: Partial<Record<JobStepName, StepDefinition>> = {
  detect: detectStep,
  oauth_wait: oauthWaitStep,
}

async function detect(deps: IngestionDeps, domain: string): Promise<PlatformDetection> {
  try {
    return await detectPlatform({ fetcher: deps.fetcher }, domain)
  } catch (cause) {
    // The site being unreachable is the ordinary reason this fails, and it is
    // usually temporary — a slow host, a redirect loop being fixed.
    throw new RetryableFailure(
      'store_unreachable',
      `Could not read ${domain} to work out what it runs on.`,
      { cause },
    )
  }
}

/**
 * Provider errors carry their own classification but cannot extend the job
 * runtime's failure classes — the provider packages must not depend on it. A
 * dead token has to become the runtime's own class here, because that is what
 * routes the store to the reconnect screen instead of the dead-letter queue.
 */
async function withTokenInvalidRouting<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (isTokenInvalid(error)) {
      throw new TokenInvalidFailure('shopify', error.message, { cause: error })
    }
    throw error
  }
}

function isTokenInvalid(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error as { errorClass?: unknown }).errorClass === 'shopify_token_invalid'
  )
}

async function requireDomain(deps: IngestionDeps, accountId: string): Promise<string> {
  const domain = await deps.domains.readNormalized(accountId)
  if (!domain) {
    throw new TerminalFailure('no_domain', 'This account has not claimed a domain.')
  }
  return domain
}

/**
 * The store name detection found, read back off the step that found it.
 *
 * It lives in the step's recorded output rather than in a column of its own,
 * because the columns of this schema wave were fixed before this card and a
 * feature card does not add migrations. The step output is durable, is already
 * the record of what that step decided, and is exactly one row away.
 */
export async function readDetectedShopHandle(
  db: Db,
  accountId: string,
): Promise<string | undefined> {
  const run = await findRunForAccount(db, accountId)
  if (!run) return undefined
  const step = await findStep(db, run.jobId, 'detect')
  const output = step?.outputRef as DetectOutput | null | undefined
  return output?.shopHandle
}
