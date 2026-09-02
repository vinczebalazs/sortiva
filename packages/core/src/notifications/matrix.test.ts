import { describe, expect, it } from 'vitest'
import { NOTIFICATION_TYPES } from '../contracts/opportunities'
import {
  NOTIFICATION_MATRIX,
  assertMatrixCoversEveryType,
  notificationChannels,
  type EmailPolicy,
  type InAppSurface,
} from './matrix'

/**
 * The channel matrix, held row by row against the UI spec's notification table.
 *
 * Written as one literal table rather than as assertions about the code,
 * because the point is to compare two tables. Changing where an event reaches
 * the merchant has to break this test — that is a product decision, not a
 * refactor.
 */

const EXPECTED: Record<string, { surface: InAppSurface; email: EmailPolicy; defaultOn: boolean }> = {
  oauth_reminder: { surface: 'dashboard_card', email: 'always', defaultOn: true },
  ingestion_review_ready: { surface: 'bell', email: 'always', defaultOn: true },
  opportunities_ready: { surface: 'bell', email: 'always', defaultOn: true },
  new_opportunities_found: { surface: 'bell', email: 'monthly_summary_only', defaultOn: false },
  optimize_recommendation_ready: { surface: 'bell', email: 'none', defaultOn: false },
  merchant_task_created: {
    surface: 'attention_list',
    email: 'monthly_summary_only',
    defaultOn: false,
  },
  article_published: { surface: 'bell', email: 'opt_in', defaultOn: false },
  draft_ready_for_review: { surface: 'bell', email: 'always', defaultOn: true },
  topic_held_by_gate: { surface: 'calendar_card', email: 'monthly_summary_only', defaultOn: false },
  monthly_summary_ready: { surface: 'bell', email: 'always', defaultOn: true },
  repair_needed: { surface: 'attention_list', email: 'always', defaultOn: true },
  connection_lost_shopify: { surface: 'banner', email: 'always', defaultOn: true },
  connection_lost_gsc: { surface: 'banner', email: 'always', defaultOn: true },
  payment_failed: { surface: 'banner', email: 'always', defaultOn: true },
  export_url_reminder: { surface: 'attention_list', email: 'always', defaultOn: true },
}

describe('notification channel matrix', () => {
  it('has a row for every type in the closed enum, and no others', () => {
    expect(NOTIFICATION_MATRIX.map((row) => row.type).sort()).toEqual([...NOTIFICATION_TYPES].sort())
    expect(() => assertMatrixCoversEveryType()).not.toThrow()
  })

  describe('in-app column', () => {
    for (const [type, expected] of Object.entries(EXPECTED)) {
      it(`${type} surfaces as ${expected.surface}`, () => {
        expect(notificationChannels(type as never).surface).toBe(expected.surface)
      })
    }
  })

  describe('email column', () => {
    for (const [type, expected] of Object.entries(EXPECTED)) {
      it(`${type} emails ${expected.email}, default ${expected.defaultOn ? 'on' : 'off'}`, () => {
        const row = notificationChannels(type as never)
        expect(row.email).toBe(expected.email)
        expect(row.emailDefaultOn).toBe(expected.defaultOn)
      })
    }
  })

  it('gives a preference only to the rows a merchant may switch off', () => {
    for (const row of NOTIFICATION_MATRIX) {
      expect(Boolean(row.preference)).toBe(row.toggleable)
    }
  })

  it('makes the pipeline-stopping and activation events untoggleable', () => {
    // Not a flag the send path checks: these types simply have no preference to
    // read, so there is nothing to switch off.
    const fixed = [
      'connection_lost_shopify',
      'connection_lost_gsc',
      'payment_failed',
      'opportunities_ready',
      'ingestion_review_ready',
      'repair_needed',
      'draft_ready_for_review',
    ] as const
    for (const type of fixed) {
      expect(notificationChannels(type).toggleable).toBe(false)
      expect(notificationChannels(type).preference).toBeUndefined()
    }
  })

  it('derives every dedupe key from the event, never from chance', () => {
    for (const row of NOTIFICATION_MATRIX) {
      expect(['ref', 'iso_week', 'year_month', 'sweep_threshold']).toContain(row.dedupeKey.kind)
    }
  })
})
