import type { ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { declare, match, scaffolding } from './contract-dispatch'

/**
 * The guard that stops the browser suite's stand-in server inventing an
 * address.
 *
 * That server answered three paths the Opportunities screen posted to and
 * nobody had built, so every flow passed green against a server that agreed
 * with the screen and with nothing else. Declaring an answer now means looking
 * the address up in the frozen route table, and this is the proof that the
 * lookup refuses rather than shrugging.
 */

const answered = () => true
const nothing = null as unknown as ServerResponse

describe('declaring an answer in the stand-in server', () => {
  it('accepts an address the route table holds', () => {
    const route = declare('POST', '/api/opportunities/{id}/undismiss', answered)
    expect(route.pattern.exec('/api/opportunities/abc/undismiss')?.[1]).toBe('abc')
  })

  it('refuses the three addresses this suite used to answer for itself', () => {
    for (const path of [
      '/api/opportunities/{id}/restore',
      '/api/opportunities/{id}/recommendations',
      '/api/opportunities/{id}/tasks/{taskId}',
    ]) {
      expect(() => declare('POST', path, answered), path).toThrow(/route table does not declare/)
    }
  })

  it('refuses an address that exists under a different method', () => {
    expect(() => declare('DELETE', '/api/opportunities/{id}/dismiss', answered)).toThrow(
      /route table does not declare/,
    )
  })

  it('refuses a parameter spelled the way the directory spells it', () => {
    // `[id]` is Next's spelling and `{id}` is the contract's. Only one of them
    // can be compared to the table, so the other has to be refused rather than
    // quietly matching nothing at run time.
    expect(() => declare('POST', '/api/opportunities/[id]/dismiss', answered)).toThrow(
      /route table does not declare/,
    )
  })

  it('keeps the suite’s own control surface under one prefix', () => {
    expect(() => scaffolding('POST', '/api/_e2e/reset', answered)).not.toThrow()
    expect(() => scaffolding('POST', '/api/opportunities/{id}/restore', answered)).toThrow(
      /test scaffolding lives under that prefix/,
    )
  })
})

describe('choosing which answer a request wants', () => {
  const table = [
    declare('GET', '/api/opportunities/scan-status', answered),
    declare('GET', '/api/opportunities/{id}', answered),
  ]

  it('takes the first declared address that matches, so a fixed segment can win', () => {
    // The route table orders these two deliberately: a consumer matching in
    // order would otherwise read "scan-status" as an opportunity id and answer
    // the wrong shape for a progress request.
    expect(match(table, 'GET', '/api/opportunities/scan-status')?.route.path).toBe(
      '/api/opportunities/scan-status',
    )
    expect(match(table, 'GET', '/api/opportunities/abc')?.route.path).toBe(
      '/api/opportunities/{id}',
    )
  })

  it('matches a parameter to one segment and no further', () => {
    expect(match(table, 'GET', '/api/opportunities/abc/tasks/1')).toBeNull()
    expect(match(table, 'POST', '/api/opportunities/abc')).toBeNull()
  })

  it('hands the handler the parameters the address named', async () => {
    const seen: string[][] = []
    const applied = [
      declare('POST', '/api/recommendations/{id}/apply', (_response, request) => {
        seen.push([...request.params])
        return true
      }),
    ]
    const found = match(applied, 'POST', '/api/recommendations/rec-9/apply')
    await found?.route.handler(nothing, { params: found.params, body: '', query: new URLSearchParams() })
    expect(seen).toEqual([['rec-9']])
  })
})
