import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTES } from '@sortiva/core'

/**
 * The build plan's T1.1 line: "repository scoping enforced in all routes".
 *
 * A rule that lives only in a reviewer's head is not enforced, so this walks
 * every shipped route file and requires that any route the frozen route table
 * marks `auth: 'session'` goes through `withAccount` — the one function that
 * turns a session into the scope repositories demand (tech §3). It grows with
 * the app: a later lane's authenticated route that queries on an id from the
 * request body fails here.
 */

const apiRoot = fileURLToPath(new URL('../../', import.meta.url))

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...routeFiles(full))
    else if (entry === 'route.ts' || entry === 'route.tsx') out.push(full)
  }
  return out
}

/** `apps/web/app/api/account/route.ts` → `/api/account`; `[id]` → `{id}`, as the table writes it. */
function urlPathOf(file: string): string {
  const dir = relative(apiRoot, file).split(sep).slice(0, -1)
  const segments = dir.map((s) => (s.startsWith('[') ? `{${s.slice(1, -1)}}` : s))
  return `/api/${segments.join('/')}`.replace(/\/$/, '')
}

describe('every authenticated route resolves its account from the session (tech §3)', () => {
  const files = routeFiles(apiRoot)

  it('finds the shipped route files', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('wraps every `session` route in withAccount', () => {
    const unwrapped: string[] = []
    for (const file of files) {
      const path = urlPathOf(file)
      const declared = ROUTES.filter((r) => r.path === path)
      if (declared.length === 0) continue // Auth.js owns /api/auth/*; it is not in the table.
      if (!declared.some((r) => r.auth === 'session')) continue
      if (!/\bwithAccount\b/.test(readFileSync(file, 'utf8'))) unwrapped.push(path)
    }
    expect(unwrapped).toEqual([])
  })

  it('no route file reads an account id out of the request itself', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      if (/accountScope\s*\(/.test(source)) offenders.push(`${urlPathOf(file)}: mints its own scope`)
      if (/\baccountId\b\s*[:=]\s*(body|params|searchParams|request)/.test(source)) {
        offenders.push(`${urlPathOf(file)}: account id from the request`)
      }
    }
    expect(offenders).toEqual([])
  })
})
