import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CONFLICT_CODES, conflictResponseSchema, errorResponseSchema } from './errors'
import { ROUTES, routeKey, unusedConflictCodes } from './routes'
import { buildOpenApiDocument, operationIdOf, serialiseOpenApi } from './openapi'
import * as s from './schemas'

/**
 * T0.7 done-when: "`pnpm contracts:check` lists zero shape mismatches between
 * zod and OpenAPI". These assertions are the same ones the script makes, run
 * per-merge as part of `pnpm test` so the contract cannot rot between CI gates —
 * plus the invariants the contract itself has to keep.
 */

const committedPath = fileURLToPath(new URL('../../openapi.json', import.meta.url))

describe('route table', () => {
  it('covers the surfaces ui §1–§10 and tech §3 name', () => {
    const paths = new Set(ROUTES.map((r) => r.path))
    for (const required of [
      '/api/preview',
      '/api/domain/claim',
      '/api/ingestion/status',
      '/api/profile',
      '/api/opportunities',
      '/api/calendar',
      '/api/articles',
      '/api/products',
      '/api/performance/overview',
      '/api/notifications',
      '/api/settings',
      '/api/webhooks/stripe',
    ]) {
      expect(paths).toContain(required)
    }
  })

  it('has a unique method+path and operationId per route', () => {
    expect(new Set(ROUTES.map(routeKey)).size).toBe(ROUTES.length)
    expect(new Set(ROUTES.map(operationIdOf)).size).toBe(ROUTES.length)
  })

  it('gives every route a response schema and a summary', () => {
    for (const route of ROUTES) {
      expect(route.response, routeKey(route)).toBeDefined()
      expect(route.summary.length, routeKey(route)).toBeGreaterThan(0)
    }
  })

  it('resolves account scope from the session, never from a request body (tech §3)', () => {
    for (const route of ROUTES) {
      if (!route.body) continue
      const shape = (route.body as { shape?: Record<string, unknown> }).shape
      if (!shape) continue
      expect(Object.keys(shape), routeKey(route)).not.toContain('accountId')
      expect(Object.keys(shape), routeKey(route)).not.toContain('account_id')
    }
  })

  it('never gates a read on billing state (main §4.2, invariant 16)', () => {
    const gatedReads = ROUTES.filter((r) => r.method === 'GET' && r.requiresEntitlement)
    expect(gatedReads.map(routeKey)).toEqual([])
  })

  it('has no conflict code that no route can return', () => {
    expect(unusedConflictCodes()).toEqual([])
  })

  it('only lists conflict codes that exist in the enum', () => {
    const known = new Set<string>(CONFLICT_CODES)
    for (const route of ROUTES) {
      for (const code of route.conflicts ?? []) {
        expect(known.has(code), `${routeKey(route)} → ${code}`).toBe(true)
      }
    }
  })

  it('declares conflicts on the guarded transitions main §8.7 and §7.9 define', () => {
    const conflictsOf = (path: string, method = 'POST') =>
      ROUTES.find((r) => r.path === path && r.method === method)?.conflicts ?? []

    expect(conflictsOf('/api/domain/claim')).toContain('domain_already_claimed')
    expect(conflictsOf('/api/calendar/topics/{topicId}/move')).toContain('topic_already_generating')
    expect(conflictsOf('/api/calendar/topics/{topicId}/move')).toContain('topic_pinned')
    expect(conflictsOf('/api/profile/competitors')).toContain('competitor_limit_reached')
    expect(conflictsOf('/api/articles/{articleId}/refresh')).toContain('refresh_within_cooldown')
  })
})

describe('schemas', () => {
  it('carries no denominator or target in any count (invariant 23, main §8.6)', () => {
    // Every response schema, flattened to its property names.
    const document = JSON.stringify(buildOpenApiDocument())
    for (const forbidden of ['"outOf"', '"target"', '"quota"', '"remaining"', '"limit_of"']) {
      expect(document).not.toContain(forbidden)
    }
  })

  it('renders every why-line from a template key and params, never prose (invariant 8)', () => {
    const parsed = s.whyLineSchema.safeParse({
      templateKey: 'striking_distance.page_one_intent_mismatch',
      params: { position: 7.3 },
    })
    expect(parsed.success).toBe(true)
    // A rendered sentence is not a why-line: there is no field to put one in.
    expect(Object.keys(s.whyLineSchema.shape).sort()).toEqual(['params', 'templateKey'])
  })

  it('requires a source on every evidence fact (main §7.6)', () => {
    expect(
      s.evidenceFactSchema.safeParse({ key: 'impressions', value: 9402, fetchedAt: new Date().toISOString() })
        .success,
    ).toBe(false)
  })

  it('rejects an unknown conflict code', () => {
    expect(conflictResponseSchema.safeParse({ error: { code: 'nope', message: 'x' } }).success).toBe(
      false,
    )
    expect(
      conflictResponseSchema.safeParse({ error: { code: 'topic_pinned', message: 'x' } }).success,
    ).toBe(true)
  })

  it('accepts a field-level 422 body', () => {
    expect(
      errorResponseSchema.safeParse({
        error: { code: 'invalid_request', message: 'bad', details: [{ path: 'url', message: 'required' }] },
      }).success,
    ).toBe(true)
  })
})

describe('OpenAPI document', () => {
  it('matches the committed file exactly', () => {
    // The generated document is the contract; the committed file is what other
    // tools read. Drift between them is the failure this whole check exists for.
    expect(readFileSync(committedPath, 'utf8')).toBe(serialiseOpenApi())
  })

  it('documents a 409 with its codes wherever a route declares conflicts', () => {
    const document = buildOpenApiDocument() as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>
    }

    for (const route of ROUTES) {
      const operation = document.paths[route.path]![route.method.toLowerCase()]!
      if (route.conflicts?.length) {
        expect(operation.responses['409'], routeKey(route)).toBeDefined()
      } else {
        expect(operation.responses['409'], routeKey(route)).toBeUndefined()
      }
    }
  })

  it('marks session routes as secured and public ones as open', () => {
    const document = buildOpenApiDocument() as {
      paths: Record<string, Record<string, { security: unknown[] }>>
    }
    const preview = document.paths['/api/preview']!.post!
    const account = document.paths['/api/account']!.get!

    expect(preview.security).toEqual([])
    expect(account.security).toEqual([{ sessionCookie: [] }])
  })

  it('turns array query filters into repeatable parameters', () => {
    const document = buildOpenApiDocument() as {
      paths: Record<string, Record<string, { parameters?: { name: string; explode?: boolean }[] }>>
    }
    const action = document.paths['/api/opportunities']!.get!.parameters!.find(
      (p) => p.name === 'action',
    )
    expect(action?.explode).toBe(true)
  })
})
