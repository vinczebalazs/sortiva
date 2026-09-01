import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * T1.2's done-when: "grep proves no `stripe.` call outside webhook worker +
 * Checkout/Portal creators."
 *
 * Written as a test rather than a one-off grep so it keeps holding as other
 * lanes land. It is the executable form of invariant 16's hardest sentence:
 * **no Stripe API call ever sits in a request path or at scheduler dequeue.**
 * Entitlement is read from the local `subscriptions` row; a Stripe call that
 * crept into, say, the calendar's dequeue check would make a Stripe outage a
 * publishing outage, and would be invisible in review.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/** The SDK import allowlist the lint rule also enforces (invariant 25). */
const SDK_IMPORT_ALLOWED = ['packages/providers/src/stripe/']

/**
 * Every method on `StripeBillingProvider` that goes over the wire, and the only
 * files allowed to call one.
 */
const REMOTE_METHODS = [
  'createCheckoutSession',
  'createPortalSession',
  'constructEvent',
  'fetchSubscription',
] as const

const CALL_SITES_ALLOWED = [
  // The wrapper itself and its test double.
  'packages/providers/src/stripe/',
  // The Checkout and Customer Portal creators.
  'packages/core/src/billing/checkout.ts',
  // The webhook status worker — reads the subscription a Checkout session named.
  'packages/core/src/billing/processing.ts',
  // The nightly reconciliation, which is a scheduled job, not a request path.
  'packages/core/src/billing/reconcile.ts',
  // The receiver, which verifies the signature before storing anything.
  'apps/web/app/api/webhooks/stripe/_lib/receiver.ts',
]

const SCAN_ROOTS = ['packages', 'apps']
const SKIP_DIRECTORIES = new Set(['node_modules', '.next', 'dist', 'coverage', '.turbo'])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRECTORIES.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const files = SCAN_ROOTS.flatMap((root) => sourceFiles(join(repoRoot, root))).map((file) =>
  relative(repoRoot, file).split('\\').join('/'),
)

/** Tests assert against these names by definition; the rule is about product code. */
function isTest(path: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(path) || path.endsWith('/testing.ts')
}

function allowed(path: string, allowList: readonly string[]): boolean {
  return allowList.some((prefix) => path === prefix || path.startsWith(prefix))
}

describe('the Stripe SDK is imported in exactly one place (invariant 25)', () => {
  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('no file outside the wrapper imports `stripe`', () => {
    const offenders = files.filter((path) => {
      if (allowed(path, SDK_IMPORT_ALLOWED)) return false
      const source = readFileSync(join(repoRoot, path), 'utf8')
      return /from\s+['"]stripe['"]|require\(\s*['"]stripe['"]\s*\)/.test(source)
    })
    expect(offenders).toEqual([])
  })
})

describe('no Stripe API call sits in a request path (invariant 16)', () => {
  it('only the webhook worker, the reconciliation and the Checkout/Portal creators call Stripe', () => {
    const offenders: string[] = []
    for (const path of files) {
      if (isTest(path) || allowed(path, CALL_SITES_ALLOWED)) continue
      const source = readFileSync(join(repoRoot, path), 'utf8')
      for (const method of REMOTE_METHODS) {
        if (new RegExp(`\\.${method}\\s*\\(`).test(source)) {
          offenders.push(`${path} calls ${method}()`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('no route handler calls Stripe at all', () => {
    const offenders: string[] = []
    for (const path of files.filter((f) => /\/route\.tsx?$/.test(f))) {
      const source = readFileSync(join(repoRoot, path), 'utf8')
      for (const method of REMOTE_METHODS) {
        if (new RegExp(`\\.${method}\\s*\\(`).test(source)) offenders.push(`${path}: ${method}()`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('entitlement is never decided from a Stripe read', () => {
    // The scheduler and the API entitlement checks go through `billingGate` /
    // `isEntitled`, which take the local row. Nothing in `packages/core`
    // outside the billing module may even name the provider port.
    const offenders = files.filter((path) => {
      if (isTest(path)) return false
      if (!path.startsWith('packages/core/src/')) return false
      if (path.startsWith('packages/core/src/billing/')) return false
      return /StripeBillingProvider/.test(readFileSync(join(repoRoot, path), 'utf8'))
    })
    expect(offenders).toEqual([])
  })

  it('the rule is not vacuous — it does see the sanctioned call sites', () => {
    const sanctioned = files.filter((path) => {
      if (!allowed(path, CALL_SITES_ALLOWED)) return false
      const source = readFileSync(join(repoRoot, path), 'utf8')
      return REMOTE_METHODS.some((method) => new RegExp(`\\.${method}\\s*\\(`).test(source))
    })
    expect(sanctioned.length).toBeGreaterThanOrEqual(4)
  })
})
