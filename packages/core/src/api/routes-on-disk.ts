import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Which addresses the web application actually serves, read from the route
 * files themselves.
 *
 * **Deliberately not exported from this package's barrel.** It reads the
 * filesystem, and the barrel is pulled into browser bundles; a route file that
 * imports the barrel would drag `node:fs` into a bundle that has no filesystem.
 * Import it by path.
 *
 * It exists because the contract check compared the contract to itself. The
 * frozen route table was checked against the document generated from it, and
 * the document against the table again — so ten endpoints built at addresses
 * the table did not know about passed that check every time it ran. What a
 * route table needs comparing to is the routes.
 */

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const
export type HttpMethod = (typeof METHODS)[number]

/** `[id]` is how a parameter is spelt on disk; `{id}` is how the contract spells it. */
export function contractPathOf(directory: string): string {
  return `/api/${directory}`
    .split('/')
    .map((segment) =>
      segment.startsWith('[') && segment.endsWith(']') ? `{${segment.slice(1, -1)}}` : segment,
    )
    .join('/')
}

/**
 * The methods one route file exports.
 *
 * Two spellings, because the identity library's own route hands its handlers
 * over by destructuring what the library built, so the ordinary
 * `export const POST` never appears in it.
 */
export function methodsExportedBy(source: string): HttpMethod[] {
  const found = new Set<HttpMethod>()
  for (const match of source.matchAll(
    /export\s+(?:const|(?:async\s+)?function)\s+(GET|POST|PATCH|PUT|DELETE)\b/g,
  )) {
    found.add(match[1] as HttpMethod)
  }
  for (const match of source.matchAll(/export\s+const\s*\{([^}]*)\}/g)) {
    for (const name of (match[1] ?? '').split(',')) {
      const trimmed = name.trim() as HttpMethod
      if (METHODS.includes(trimmed)) found.add(trimmed)
    }
  }
  return [...found]
}

/**
 * Every `METHOD /api/…` a route file under `apiRoot` serves.
 *
 * Directories Next treats as grouping only — `(app)`, `(public)` — do not
 * appear in a URL, and none exist under the API root today; a segment in
 * parentheses is dropped rather than silently becoming part of a path, so that
 * introducing one does not quietly invent an address nobody serves.
 */
export function routesOnDisk(apiRoot: string): Set<string> {
  const served = new Set<string>()
  const walk = (directory: string, relative: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const next = join(directory, entry.name)
      if (entry.isDirectory()) {
        const grouping = entry.name.startsWith('(') && entry.name.endsWith(')')
        const segment = grouping ? relative : relative === '' ? entry.name : `${relative}/${entry.name}`
        walk(next, segment)
      } else if (entry.name === 'route.ts') {
        for (const method of methodsExportedBy(readFileSync(next, 'utf8'))) {
          served.add(`${method} ${contractPathOf(relative)}`)
        }
      }
    }
  }
  walk(apiRoot, '')
  return served
}

/**
 * A declared address as a matcher: `{id}` stands for one path segment, and a
 * trailing `*` covers every address below it — which is how the identity
 * library's own family of routes is named.
 */
export function patternFor(path: string): RegExp {
  if (path.endsWith('/*')) {
    return new RegExp(`^${path.slice(0, -2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/.*)?$`)
  }
  const source = path
    .split(/\{[^}]+\}/)
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('([^/]+)')
  return new RegExp(`^${source}$`)
}
