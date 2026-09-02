import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '../strings'
import { OpportunityDrawer } from './OpportunityDrawer'
import {
  conflictMessage,
  createOpportunityActions,
  type ActionSurface,
  type OpportunitiesApi,
  type PostOutcome,
  type Toast,
} from './actions'
import { recommendationFilename, recommendationHtml, recommendationMarkdown } from './download'
import type { OpportunityDetail, OpportunityRow } from './types'

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element)
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .replaceAll('&#x2F;', '/')

const AT = '2026-02-02T09:00:00.000Z'

const row: OpportunityRow = {
  id: '22222222-2222-4222-8222-222222222222',
  signalType: 'striking_distance',
  entityRef: { kind: 'page', id: '/collections/trail-running', label: 'Collection: Trail running shoes' },
  recommendedAction: 'OPTIMIZE',
  status: 'new',
  impact: 'high',
  impactScore: 78,
  confidence: 'high',
  confidenceScore: 84,
  confidenceFactors: [],
  evidence: [
    { key: 'impressions', value: 8400, source: 'gsc', window: '28d', fetchedAt: AT },
    { key: 'matching_products', value: 14, source: 'catalog', fetchedAt: AT },
  ],
  why: { templateKey: 'striking_distance.page_one_intent_mismatch', params: {} },
  preconditions: [],
  rulesVersion: 'a'.repeat(64),
  limitedIntelligence: false,
  detectedAt: AT,
  scheduledFor: null,
  expiresAt: null,
}

const detail: OpportunityDetail = {
  opportunity: row,
  tasks: [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', label: 'Rewrite the collection title', state: 'open' },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', label: 'Add a sizing FAQ', state: 'applied' },
  ],
  serpSnapshot: [
    { position: 1, domain: 'competitor.example', url: 'https://competitor.example/trail' },
    { position: 4, domain: 'other.example', url: 'https://other.example/trail' },
  ],
  recommendation: {
    state: 'ready',
    fields: [
      {
        field: 'title_tag',
        current: 'Wide Fit Trail',
        suggested: 'Wide-Fit Trail Running Shoes | Widths E–4E',
        evidence: 'Three of the top five results name the fit',
      },
      { field: 'meta_description', current: null, suggested: 'Fourteen trail shoes in E to 4E widths.', evidence: null },
    ],
    internalLinksIn: [{ fromUrl: '/blogs/field-notes/sizing', anchor: 'wide fit' }],
    internalLinksOut: [{ toUrl: '/products/scafell-3', anchor: 'Scafell 3' }],
    intentNote: 'The query compares fit, and the page does not.',
    failureReason: null,
  },
  history: [
    { at: AT, from: null, to: 'new', actor: 'autopilot', reason: null },
    { at: AT, from: 'new', to: 'accepted', actor: 'user', reason: null },
  ],
  outcome: null,
}

// ── The drawer ───────────────────────────────────────────────────────────────

describe('the detail drawer', () => {
  const html = render(createElement(OpportunityDrawer, { detail }))

  it('puts every fact in a row with where it came from, over what window, and how fresh it is', () => {
    expect(html).toContain('data-drawer-section="evidence"')
    expect(html).toContain(t('opportunities.drawer.evidenceSource'))
    expect(html).toContain(t('opportunities.drawer.evidenceWindow'))
    expect(html).toContain(t('opportunities.drawer.evidenceFetched'))
    expect(html).toContain('data-evidence-key="impressions"')
    expect(html).toContain('Search Console')
    expect(html).toContain('last 28 days')
    // A fact measured now rather than over a period still says so.
    expect(html).toContain(t('opportunities.window.current'))
  })

  it('shows who else ranks for the query', () => {
    expect(html).toContain('data-drawer-section="serp"')
    expect(html).toContain('competitor.example')
  })

  it('lists the tasks with a way to mark each one applied', () => {
    expect(html).toContain('data-drawer-section="tasks"')
    expect(html).toContain('data-task-action="applied"')
    expect(html).toContain('data-task-action="skipped"')
    // One already applied offers no buttons, only its state.
    expect(html).toContain('data-task-state="applied"')
  })

  it('records who moved it and when', () => {
    expect(html).toContain('data-drawer-section="history"')
    expect(html).toContain(t('opportunities.drawer.historyActor.autopilot'))
    expect(html).toContain(t('opportunities.drawer.historyActor.user'))
  })

  it('says nothing about the result until there is a result', () => {
    expect(html).toContain(t('opportunities.drawer.outcomePending'))
  })
})

describe('the OPTIMIZE recommendation view', () => {
  const html = render(createElement(OpportunityDrawer, { detail }))

  it('puts what the page says now beside what it could say, per field', () => {
    expect(html).toContain('data-rec-field="title_tag"')
    expect(html).toContain('data-rec-side="current"')
    expect(html).toContain('data-rec-side="suggested"')
    expect(html).toContain('Wide-Fit Trail Running Shoes')
  })

  it('offers a copy button per field and both downloads', () => {
    expect(html).toContain('data-rec-copy="title_tag"')
    expect(html).toContain('data-rec-copy="meta_description"')
    expect(html).toContain('data-rec-download="markdown"')
    expect(html).toContain('data-rec-download="html"')
  })

  it('says outright that nobody applied any of it', () => {
    expect(html).toContain(t('opportunities.rec.neverApplies'))
  })

  it('refuses to regenerate until the evidence has moved', () => {
    expect(html).toContain('data-rec-action="regenerate"')
    expect(html).toContain(t('opportunities.rec.regenerateUnavailable'))
  })

  it('shows no partial output when the pipeline could not produce a safe one', () => {
    const failed = render(
      createElement(OpportunityDrawer, {
        detail: {
          ...detail,
          recommendation: {
            state: 'failed_validation',
            fields: [],
            internalLinksIn: [],
            internalLinksOut: [],
            intentNote: null,
            failureReason: null,
          },
        },
      }),
    )
    expect(failed).toContain("We couldn't produce a safe recommendation for this page")
    expect(failed).not.toContain('data-rec-side="suggested"')
  })
})

describe('the FIX view', () => {
  const html = render(
    createElement(OpportunityDrawer, {
      detail: {
        ...detail,
        opportunity: { ...row, recommendedAction: 'FIX', signalType: 'cannibalization' },
      },
    }),
  )

  it('says the recommendation came from the store’s own data, not a model', () => {
    expect(html).toContain('data-drawer-section="fix"')
    expect(html).toContain(t('opportunities.fix.deterministic'))
  })

  it('says we will not touch the theme or the redirects', () => {
    expect(html).toContain(
      'Sortiva does not change your theme or redirects — apply these in Shopify.',
    )
  })

  it('does not offer the OPTIMIZE copy-and-download view', () => {
    expect(html).not.toContain('data-drawer-section="recommendation"')
  })
})

describe('the HOLD view', () => {
  const html = render(
    createElement(OpportunityDrawer, {
      detail: {
        ...detail,
        opportunity: {
          ...row,
          recommendedAction: 'HOLD',
          status: 'blocked',
          preconditions: [
            {
              code: 'missing_product_details',
              whatToDo: {
                templateKey: 'precondition.missing_product_details',
                params: { products: 6 },
              },
            },
          ],
        },
        recommendation: null,
      },
    }),
  )

  it('is a checklist of what the store still has to say, and where to say it', () => {
    expect(html).toContain('data-drawer-section="hold"')
    expect(html).toContain(t('template.precondition.missing_product_details', { products: 6 }))
    expect(html).toContain(t('opportunities.hold.openProducts'))
  })

  it('promises to look again by itself rather than asking the merchant to come back', () => {
    expect(html).toContain(t('opportunities.hold.recheck'))
  })
})

// ── The downloadable recommendation ──────────────────────────────────────────

describe('the downloadable recommendation', () => {
  it('carries every field, both link lists and the note that nothing was applied', () => {
    const markdown = recommendationMarkdown(detail)
    expect(markdown).toContain('# Collection: Trail running shoes')
    expect(markdown).toContain('Wide-Fit Trail Running Shoes | Widths E–4E')
    expect(markdown).toContain('/blogs/field-notes/sizing')
    expect(markdown).toContain('/products/scafell-3')
    expect(markdown).toContain(t('opportunities.rec.neverApplies'))
  })

  it('says "nothing there today" rather than leaving a field blank', () => {
    expect(recommendationMarkdown(detail)).toContain(t('opportunities.rec.currentEmpty'))
  })

  it('escapes the store’s own words on the way into HTML', () => {
    const risky = {
      ...detail,
      opportunity: { ...row, entityRef: { ...row.entityRef, label: 'Trail <script>alert(1)</script>' } },
    }
    const html = recommendationHtml(risky)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('names the file after the page it is about', () => {
    expect(recommendationFilename('Collection: Trail running shoes', 'md')).toBe(
      'sortiva-collection-trail-running-shoes.md',
    )
    expect(recommendationFilename('«»', 'html')).toBe('sortiva-recommendation.html')
  })
})

// ── Dismiss, undo, and a list that moved underneath ──────────────────────────

function surfaceDouble() {
  const toasts: Toast[] = []
  const hidden: [string, boolean][] = []
  const busy: [string, boolean][] = []
  let refreshes = 0
  const surface: ActionSurface = {
    toast: (toast) => void toasts.push(toast),
    refresh: () => void (refreshes += 1),
    setHidden: (id, value) => void hidden.push([id, value]),
    setBusy: (id, value) => void busy.push([id, value]),
  }
  return { surface, toasts, hidden, busy, refreshes: () => refreshes }
}

function apiDouble(outcome: PostOutcome = { ok: true }) {
  const posts: string[] = []
  const api: OpportunitiesApi = {
    list: async () => null,
    detail: async () => null,
    post: async (path) => {
      posts.push(path)
      return outcome
    },
  }
  return { api, posts }
}

describe('dismissing an opportunity', () => {
  let scene: ReturnType<typeof surfaceDouble>

  beforeEach(() => {
    scene = surfaceDouble()
  })

  it('takes the card off the list and offers it back for as long as the toast is up', async () => {
    const { api, posts } = apiDouble()
    await createOpportunityActions(api, scene.surface).dismiss(row)

    expect(posts).toEqual([`/${row.id}/dismiss`])
    expect(scene.hidden).toEqual([[row.id, true]])
    expect(scene.toasts[0]?.message).toBe(t('opportunities.toast.dismissed'))
    expect(scene.toasts[0]?.undoLabel).toBe(t('opportunities.toast.undo'))
  })

  it('puts the card back and asks the server to restore it when the undo is taken', async () => {
    const { api, posts } = apiDouble()
    await createOpportunityActions(api, scene.surface).dismiss(row)

    scene.toasts[0]?.onUndo?.()
    await vi.waitFor(() => expect(posts).toHaveLength(2))

    expect(posts[1]).toBe(`/${row.id}/restore`)
    expect(scene.hidden.at(-1)).toEqual([row.id, false])
  })

  it('brings the card back when the dismissal itself failed', async () => {
    const { api } = apiDouble({ ok: false, conflict: 'opportunity_already_updated' })
    await createOpportunityActions(api, scene.surface).dismiss(row)

    expect(scene.hidden).toEqual([
      [row.id, true],
      [row.id, false],
    ])
  })

  it('unlocks the card buttons whatever the answer was', async () => {
    const { api } = apiDouble({ ok: false, conflict: null })
    await createOpportunityActions(api, scene.surface).dismiss(row)
    expect(scene.busy).toEqual([
      [row.id, true],
      [row.id, false],
    ])
  })
})

describe('an opportunity the latest scan moved underneath us', () => {
  it('says so and re-reads the list rather than failing silently', async () => {
    const scene = surfaceDouble()
    const { api } = apiDouble({ ok: false, conflict: 'opportunity_already_updated' })
    await createOpportunityActions(api, scene.surface).schedule(row)

    expect(scene.toasts[0]?.message).toBe(
      'This opportunity was updated by the latest scan — refreshed.',
    )
    expect(scene.refreshes()).toBe(1)
  })

  it('words an opportunity that has already moved on differently from one that was re-scored', () => {
    expect(conflictMessage('opportunity_not_open')).toBe(t('opportunities.toast.notOpen'))
    expect(conflictMessage('opportunity_already_updated')).toBe(t('opportunities.toast.conflict'))
    // A request that never reached the server is neither.
    expect(conflictMessage(null)).toBe(t('opportunities.toast.failed'))
  })

  it('names the day the server gave, not the day that was asked for', async () => {
    const scene = surfaceDouble()
    const api: OpportunitiesApi = {
      list: async () => null,
      detail: async () => null,
      post: async () => ({ ok: true, body: { scheduledFor: '2026-02-18' } }),
    }
    await createOpportunityActions(api, scene.surface).schedule(row)
    expect(scene.toasts[0]?.message).toBe(
      t('opportunities.toast.scheduled', { date: '18 Feb 2026' }),
    )
  })
})
