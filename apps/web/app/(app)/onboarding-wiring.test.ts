import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NAV_ITEMS, scanProduced } from '@sortiva/ui'
import { RESPONSE_FIXTURES } from '@sortiva/ui/msw'

/**
 * Onboarding ends by moving the merchant off the dashboard, and that move is
 * the activation moment the funnel measures. Nothing rendered proves it
 * happened, so these assertions cover the two halves separately: what decides
 * the wait is over, and where the wait sends them.
 */

const here = dirname(fileURLToPath(import.meta.url))
const source = (path: string) => readFileSync(join(here, path), 'utf8')

describe('what ends the wait for the first scan', () => {
  it('is the scan having produced something, read from the opportunities response', () => {
    expect(scanProduced(RESPONSE_FIXTURES['GET /api/opportunities'])).toBe(true)
  })

  it('is not a scan that has merely started', () => {
    expect(scanProduced({ lastScanAt: null })).toBe(false)
    expect(scanProduced({})).toBe(false)
    expect(scanProduced(null)).toBe(false)
  })
})

describe('where the wait sends the merchant', () => {
  const dashboard = source('dashboard/page.tsx')

  it('is Opportunities, and the same address the navigation uses', () => {
    const opportunities = NAV_ITEMS.find((item) => item.id === 'opportunities')!
    expect(opportunities.href).toBe('/opportunities')
    expect(dashboard).toContain(`const OPPORTUNITIES = '${opportunities.href}'`)
    expect(dashboard).toContain('<FindingOpportunitiesSurface href={OPPORTUNITIES} />')
  })

  it('is not the dashboard, which is where the merchant already is', () => {
    // The spec is explicit that the first opportunity set — not confirming the
    // profile — is the end of onboarding, so landing back here would hide it.
    expect(dashboard).not.toContain("href=\"/dashboard\"")
  })

  it('lands on the headline for what was found', () => {
    expect(source('opportunities/page.tsx')).toContain('<ActivationHeader')
  })
})
