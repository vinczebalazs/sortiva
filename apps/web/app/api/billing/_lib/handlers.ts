import {
  BillingNotSetUp,
  checkoutRequestSchema,
  openBillingPortal,
  planWithPrices,
  PlanPricesUnavailable,
  startCheckout,
  UnknownBillingInterval,
} from '@sortiva/core'
import type { PriceCatalog, StripeBillingProvider } from '@sortiva/core'
import { db, findAccountById, type Db } from '@sortiva/db'
import { PosthogServerCapture } from '@sortiva/providers'
import type { AccountHandler } from '../../auth/_lib/session'
import { appUrl, BillingNotConfigured, priceCatalog, stripeProvider } from './config'

/**
 * The two payment surfaces, and the only two. Neither reads or writes
 * entitlement: Checkout starts a purchase, the Portal opens Stripe's own
 * management screen, and the `subscriptions` row that decides what the account
 * may do is written by the webhook worker alone.
 *
 * We render no card form, ever — both handlers return a Stripe-hosted URL for
 * the browser to leave to.
 */

export interface BillingHandlerOptions {
  database?: Db
  /** Injected by tests; production builds the single instrumented wrapper. */
  stripe?: StripeBillingProvider
  prices?: PriceCatalog
  appUrl?: string
}

let capture: PosthogServerCapture | undefined

function analytics(): PosthogServerCapture {
  capture ??= new PosthogServerCapture()
  return capture
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}

/** One button, straight to Stripe Checkout. We render no card form, ever. */
export function makeCheckoutHandler(options: BillingHandlerOptions = {}): AccountHandler {
  return async (request, { scope }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return error(422, 'invalid_body', 'Expected a JSON body.')
    }

    const parsed = checkoutRequestSchema.safeParse(body)
    if (!parsed.success) {
      return Response.json(
        {
          error: {
            code: 'invalid_body',
            message: 'Choose a monthly or annual plan.',
            details: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        },
        { status: 422 },
      )
    }

    const account = await findAccountById(options.database ?? db(), scope)
    if (!account || account.deletedAt) {
      return error(404, 'account_not_found', 'This account no longer exists.')
    }

    try {
      const { url } = await startCheckout(
        {
          stripe: options.stripe ?? stripeProvider(),
          prices: options.prices ?? priceCatalog(),
          appUrl: options.appUrl ?? appUrl(),
          capture: analytics(),
        },
        {
          accountId: scope.accountId,
          email: account.email,
          interval: parsed.data.interval,
          customerId: account.stripeCustomerId,
        },
      )
      return Response.json({ url })
    } catch (thrown) {
      return billingFailure(thrown)
    }
  }
}

/** Sends the merchant to Stripe's own management screen. Cancellation lives there, not here. */
export function makePortalHandler(options: BillingHandlerOptions = {}): AccountHandler {
  return async (_request, { scope }) => {
    const account = await findAccountById(options.database ?? db(), scope)
    if (!account || account.deletedAt) {
      return error(404, 'account_not_found', 'This account no longer exists.')
    }

    try {
      const { url } = await openBillingPortal(
        { stripe: options.stripe ?? stripeProvider(), appUrl: options.appUrl ?? appUrl() },
        { customerId: account.stripeCustomerId },
      )
      return Response.json({ url })
    } catch (thrown) {
      return billingFailure(thrown)
    }
  }
}

function billingFailure(thrown: unknown): Response {
  if (thrown instanceof BillingNotSetUp) return error(404, thrown.code, thrown.message)
  if (thrown instanceof UnknownBillingInterval) return error(422, 'unknown_interval', thrown.message)
  if (thrown instanceof BillingNotConfigured) {
    // Pause rather than offer something half-working. Without
    // price ids or a key there is no purchase to offer, and pretending
    // otherwise sends the merchant to a broken Stripe page.
    return error(503, 'billing_not_configured', 'Billing is temporarily unavailable.')
  }
  throw thrown
}

/**
 * The plan card's price and its monthly/annual toggle.
 *
 * Public and read-only: the plan screen is reachable before signup, it reads no
 * account row and it changes nothing. Amounts live in Stripe alone, so this asks
 * Stripe and caches the answer (`planWithPrices`).
 */
export function makePlanHandler(options: BillingHandlerOptions = {}) {
  return async (): Promise<Response> => {
    try {
      const plan = await planWithPrices({
        stripe: options.stripe ?? stripeProvider(),
        prices: options.prices ?? priceCatalog(),
      })
      return Response.json(plan)
    } catch (thrown) {
      if (thrown instanceof PlanPricesUnavailable) {
        // No amount may be hardcoded anywhere, so there is no fallback to show:
        // this pauses rather than invent a price on a purchase screen.
        return error(503, thrown.code, 'Plan pricing is temporarily unavailable.')
      }
      return billingFailure(thrown)
    }
  }
}

export const checkoutHandler = makeCheckoutHandler()
export const portalHandler = makePortalHandler()
export const planHandler = makePlanHandler()
