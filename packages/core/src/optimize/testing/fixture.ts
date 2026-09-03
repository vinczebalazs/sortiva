import type { FactSheet } from '../../distill/schema'
import type { OptimizeEvidencePack } from '../pack'
import type { OptimizeRecommendation } from '../recommendation'

/**
 * The worked example this directory's tests run on: a wide-fit trail-running
 * collection sitting at position 8, against ranking pages that all settle two
 * things it never mentions. Same store the opportunity-engine fixtures use, so
 * the numbers read the same way across lanes.
 *
 * Test-only — not exported from `optimize/index.ts`.
 */

export const PAGE_BODY = [
  'Our wide trail running shoes are built for runners who need more room across the forefoot.',
  '',
  'Every pair in this collection is available in D and 2E widths, and we stock them year round.',
].join('\n')

function factSheet(overrides: Partial<FactSheet> = {}): FactSheet {
  return {
    material: null,
    dimensions: null,
    weight: null,
    capacity: null,
    compatibility: [],
    use_cases_stated: [],
    care: null,
    variant_axes: [],
    price_range: null,
    certifications: [],
    origin: null,
    verifiable_claims: [],
    fluff_discarded: false,
    fact_count: 0,
    ...overrides,
  }
}

export function fixturePack(overrides: Partial<OptimizeEvidencePack> = {}): OptimizeEvidencePack {
  return {
    accountId: '11111111-1111-4111-8111-111111111111',
    opportunityId: '22222222-2222-4222-8222-222222222222',
    page: {
      url: 'https://example-store.com/collections/wide-trail-shoes',
      pageType: 'collection',
      title: 'Wide trail running shoes',
      seoTitle: 'Wide trail running shoes | Example Store',
      seoDescription: 'Trail shoes with room across the forefoot.',
      headings: ['Wide trail running shoes', 'Our widths'],
      bodyText: PAGE_BODY,
      outboundInternalLinks: ['https://example-store.com/products/ridge-2e'],
      checksum: 'page-checksum-1',
    },
    targetQuery: 'trail running shoes for wide feet',
    queries: [
      { query: 'trail running shoes for wide feet', clicks: 42, impressions: 8400, position: 8.6 },
      { query: 'wide toe box trail shoes', clicks: 11, impressions: 1900, position: 12.1 },
    ],
    queryWindowDays: 28,
    rankingPages: [
      {
        url: 'https://competitor-a.com/wide-trail',
        domain: 'competitor-a.com',
        position: 1,
        title: 'Best wide trail shoes',
        headings: ['Sizing', 'Drainage'],
        excerpt: 'How to measure your foot before buying.',
      },
    ],
    missingSubtopics: [
      {
        name: 'how to measure forefoot width',
        presentOnOurPage: false,
        ourEvidence: null,
        competitors: [
          { url: 'https://competitor-a.com/wide-trail', heading: 'Sizing' },
          { url: 'https://competitor-b.com/wide-fit', heading: 'Measure first' },
          { url: 'https://competitor-c.com/guide', heading: '' },
        ],
      },
      {
        name: 'drainage on wet trails',
        presentOnOurPage: false,
        ourEvidence: null,
        competitors: [
          { url: 'https://competitor-a.com/wide-trail', heading: 'Drainage' },
          { url: 'https://competitor-b.com/wide-fit', heading: 'Wet weather' },
          { url: 'https://competitor-c.com/guide', heading: '' },
        ],
      },
    ],
    families: [
      {
        familyId: 'fam-trail',
        name: 'Trail shoes',
        differentiationAxes: ['width', 'stack height'],
      },
    ],
    products: [
      {
        productId: 'prod-ridge',
        familyId: 'fam-trail',
        title: 'Ridge 2E',
        factSheet: factSheet({
          material: 'recycled mesh upper',
          weight: '280 g',
          use_cases_stated: ['trail running', 'wet weather'],
        }),
      },
    ],
    linkCandidates: [
      {
        url: 'https://example-store.com/pages/fitting-guide',
        title: 'Fitting guide',
        pageType: 'page',
      },
      {
        url: 'https://example-store.com/products/ridge-2e',
        title: 'Ridge 2E',
        pageType: 'product',
      },
    ],
    persona: {
      description: 'A running shop for runners with wide feet.',
      audience: 'trail runners',
      tone: 'plain and practical',
      language: 'en',
      country: 'GB',
    },
    builtAt: '2026-09-03T09:00:00.000Z',
    ...overrides,
  }
}

export function fixtureRecommendation(
  overrides: Partial<OptimizeRecommendation> = {},
): OptimizeRecommendation {
  return {
    title_tag: {
      current: 'Wide trail running shoes | Example Store',
      suggested: 'Wide trail running shoes for wide feet | Example Store',
      rationale_key: 'ctr_below_curve',
    },
    meta_description: {
      current: 'Trail shoes with room across the forefoot.',
      suggested: 'Trail shoes in D and 2E widths, with a fitting guide and wet-weather advice.',
      rationale_key: null,
    },
    headings: [{ op: 'add', level: 2, text: 'How to measure your forefoot', after: 'Our widths' }],
    sections: [
      {
        heading: 'How to measure your forefoot',
        suggested_copy:
          'Stand on a sheet of paper and mark the widest point of each foot, then compare the measurement against the width you normally wear.',
        facts_used: ['subtopic:how to measure forefoot width', 'family:fam-trail/axis:width'],
        gap_source: 'serp',
      },
    ],
    faq: [
      {
        q: 'What is the Ridge 2E made of?',
        a: 'A recycled mesh upper, at 280 g per shoe.',
        facts_used: ['product:prod-ridge/material', 'product:prod-ridge/weight'],
      },
    ],
    internal_links: {
      add_from: [
        {
          url: 'https://example-store.com/pages/fitting-guide',
          anchor: 'wide trail shoes',
        },
      ],
      add_to: [{ url: 'https://example-store.com/products/ridge-2e', anchor: 'Ridge 2E' }],
    },
    intent_note:
      'Someone searching for wide-fit trail shoes wants to know how to check their own width before buying, and this page never says.',
    ...overrides,
  }
}
