import { describe, expect, it } from 'vitest'
import {
  acceptsServerValue,
  allServerEventDefinitions,
  baseServerProperties,
  checkServerEvent,
  isDeclaredServerEvent,
  SERVER_EVENT_NAMES,
  SERVER_PROPERTY_KINDS,
} from './analytics-events'

/**
 * The promise this file defends: nothing a merchant owns — product copy, a
 * prompt, a draft article — is ever sent to the analytics vendor. The browser
 * half of the product has kept that promise structurally for a while. The
 * server half kept it by review only, which is what these tests replace.
 *
 * Four values, the same four the browser suite uses, because they are what
 * actually reached the vendor when the server wrapper was tested against this
 * rule and passed everything but the token through.
 */
const WHAT_MUST_NEVER_REACH_THE_VENDOR = [
  'Ten Ways To Style A Merino Base Layer',
  'Merino wool regulates temperature across a wide range...',
  'You are an SEO writer. Write 1200 words about...',
  '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',
]

/** Words that name a piece of the merchant's content rather than an identifier or a count. */
const CONTENT_SHAPED_NAMES = [
  'title',
  'body',
  'text',
  'content',
  'headline',
  'summary',
  'description',
  'excerpt',
  'keyword',
  'query',
  'url',
  'slug',
  'label',
  'message',
]

/**
 * The properties whose names contain a content word for a reason, listed rather
 * than silently excluded from the check. A bare name exempts that property
 * wherever it appears; an `event.property` entry exempts it on one event only,
 * which is the narrower form and the one to prefer.
 *
 * - `prompt_version` names which revision of a prompt ran, never the prompt.
 * - `opportunity_outcome_measured.label` is the four-week verdict, one of
 *   exactly three words we chose (`improved`, `neutral`, `worse`). It is
 *   declared as an `enum`, which refuses anything with a space in it or longer
 *   than sixty-four characters, so the kind rules out prose even though the
 *   name reads like it might carry some.
 */
const NAMED_FOR_A_REASON = new Set([
  'prompt_version',
  'opportunity_outcome_measured.label',
])

describe('the events the server may report', () => {
  it('names them in snake_case, matching the browser-side taxonomy', () => {
    for (const name of SERVER_EVENT_NAMES) {
      // The two the vendor names itself keep their `$`.
      expect(name).toMatch(/^\$?[a-z][a-z0-9]*(_[a-z0-9]+)*$/)
    }
  })

  it('lists each event once', () => {
    expect(new Set(SERVER_EVENT_NAMES).size).toBe(SERVER_EVENT_NAMES.length)
  })
})

describe('no event can be defined so that it carries store content', () => {
  it('gives every declared property one of the five kinds, and there is no kind for text', () => {
    for (const [event, properties] of allServerEventDefinitions()) {
      for (const [property, kind] of Object.entries(properties)) {
        expect(SERVER_PROPERTY_KINDS, `${event}.${property}`).toContain(kind)
      }
    }
    for (const [property, kind] of Object.entries(baseServerProperties())) {
      expect(SERVER_PROPERTY_KINDS, property).toContain(kind)
    }
  })

  it('refuses an article title, an article body, a prompt or a token in every kind there is', () => {
    for (const kind of SERVER_PROPERTY_KINDS) {
      for (const leaked of WHAT_MUST_NEVER_REACH_THE_VENDOR) {
        expect(acceptsServerValue(kind, leaked), `${kind} accepted ${JSON.stringify(leaked)}`).toBe(
          false,
        )
      }
    }
  })

  it('refuses text hidden in the keys of a name-to-count map', () => {
    expect(acceptsServerValue('count_map', { shopify_type: 4, inferred: 1 })).toBe(true)
    expect(
      acceptsServerValue('count_map', { 'Ten Ways To Style A Merino Base Layer': 1 }),
    ).toBe(false)
    expect(acceptsServerValue('count_map', { shopify_type: 'a lot' })).toBe(false)
  })

  it('names no property after a piece of the merchant’s content', () => {
    for (const [event, properties] of allServerEventDefinitions()) {
      for (const property of Object.keys(properties)) {
        if (NAMED_FOR_A_REASON.has(property)) continue
        if (NAMED_FOR_A_REASON.has(`${event}.${property}`)) continue
        const offending = CONTENT_SHAPED_NAMES.filter((word) => property.includes(word))
        expect(offending, `${event}.${property} is named after content`).toEqual([])
      }
    }
  })
})

describe('a property no event declared never leaves the process', () => {
  it('drops it, and says it dropped it', () => {
    const checked = checkServerEvent('article_published', {
      account_id: 'acc-1',
      article_id: 'art-1',
      delivery: 'auto',
      // A plausible thing for a hurried call site to attach: the draft's title.
      article_title: 'Ten Ways To Style A Merino Base Layer',
    })

    expect(checked.sendable).toBe(true)
    expect(checked.properties).toEqual({
      account_id: 'acc-1',
      article_id: 'art-1',
      delivery: 'auto',
    })
    expect(checked.rejected).toEqual([{ key: 'article_title', reason: 'undeclared' }])
  })

  it('drops a declared property whose value is prose rather than a name', () => {
    const checked = checkServerEvent('opportunity_detected', {
      signal_type: 'striking_distance',
      recommended_action: 'Rewrite the merino base layer guide for autumn',
    })

    expect(checked.properties).toEqual({ signal_type: 'striking_distance' })
    expect(checked.rejected).toEqual([{ key: 'recommended_action', reason: 'wrong_shape' }])
  })

  it('drops a credential rather than sending it redacted', () => {
    const checked = checkServerEvent('article_published', {
      article_id: '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',
      access_token: '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',
    })

    expect(checked.properties).toEqual({})
    expect(checked.rejected).toEqual([
      { key: 'article_id', reason: 'wrong_shape' },
      { key: 'access_token', reason: 'undeclared' },
    ])
  })

  it('keeps an event it has never heard of, and strips everything it was given', () => {
    // Losing the row entirely would hide that the work happened at all. The
    // rule is about content, so the content is what goes.
    const checked = checkServerEvent('article_generated', {
      account_id: 'acc-1',
      body: 'Merino wool regulates temperature across a wide range...',
    })

    expect(checked.sendable).toBe(true)
    expect(checked.properties).toEqual({ account_id: 'acc-1' })
    expect(checked.rejected).toEqual([{ key: 'body', reason: 'undeclared' }])
    expect(isDeclaredServerEvent('article_generated')).toBe(false)
  })

  it('refuses an event whose name is not shaped like a name', () => {
    // The name is a channel too: a name built by joining a merchant's words on
    // to a prefix would carry them past a table that only checks properties.
    const checked = checkServerEvent('article Ten Ways To Style A Merino Base Layer', {})
    expect(checked.sendable).toBe(false)
    expect(checked.properties).toEqual({})
  })
})

describe('what a declared property may legitimately be', () => {
  it('accepts a null, because "we had none" carries no content', () => {
    // Gate 1 makes no model call, so it has no model id to report.
    const checked = checkServerEvent('gate_decision', {
      gate: 1,
      outcome: 'admitted',
      prompt_version: null,
      model_id: null,
    })

    expect(checked.properties).toEqual({
      gate: 1,
      outcome: 'admitted',
      prompt_version: null,
      model_id: null,
    })
    expect(checked.rejected).toEqual([])
  })

  it('accepts the judge’s per-criterion marks and refuses its written reasons', () => {
    const checked = checkServerEvent('gate_decision', {
      gate: 3,
      outcome: 'passed',
      informationGain: 4,
      factualGrounding: 5,
      // The judge also writes a sentence per criterion. That is the merchant's
      // rejection card, and it is not an analytics property.
      informationGainJustification: 'The article repeats the product page almost verbatim.',
    })

    expect(checked.properties).toEqual({
      gate: 3,
      outcome: 'passed',
      informationGain: 4,
      factualGrounding: 5,
    })
    expect(checked.rejected).toEqual([
      { key: 'informationGainJustification', reason: 'undeclared' },
    ])
  })
})
