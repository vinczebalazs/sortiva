import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * There is no in-app editor, and this is what keeps it that way.
 *
 * Main §9.3 is explicit: a merchant reviewing a draft **approves or discards**,
 * and someone who wants different wording changes it in their own store after
 * publishing. That is a product decision, not an omission — review is meant to
 * be one decision, not a text-editing surface — and the way it erodes is by
 * somebody adding "just a title tweak" endpoint later.
 *
 * So this fails if any route under the articles API accepts a change to an
 * article's words, and if anything outside the generation pipeline writes an
 * article's body.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..', '..', '..', '..')
const ARTICLES_API = join(repoRoot, 'apps', 'web', 'app', 'api', 'articles')
const ARTICLES_REPO = join(repoRoot, 'packages', 'db', 'src', 'repositories', 'articles.ts')

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** Names a route segment would have if somebody built an editor. */
const EDITOR_SEGMENTS = ['body', 'edit', 'content', 'update', 'rewrite', 'title']

describe('there is no editor for an article', () => {
  const routes = sourceFiles(ARTICLES_API).filter((f) => f.endsWith('route.ts'))

  it('has the articles API to check', () => {
    expect(routes.length, `no route files under ${ARTICLES_API}`).toBeGreaterThan(0)
  })

  it('offers no route whose path could carry an edit', () => {
    const offenders = routes
      .map((file) => relative(repoRoot, file))
      .filter((path) => EDITOR_SEGMENTS.some((segment) => path.split('/').includes(segment)))
    expect(offenders).toEqual([])
  })

  it('accepts no method that means "change this"', () => {
    const offenders: string[] = []
    for (const file of routes) {
      const source = readFileSync(file, 'utf8')
      for (const method of ['PATCH', 'PUT', 'DELETE']) {
        if (new RegExp(`export\\s+const\\s+${method}\\b`).test(source)) {
          offenders.push(`${relative(repoRoot, file)} exports ${method}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * The body has exactly one writer, and it is the pipeline that generated it.
   * A second writer anywhere is an editor, whatever it is called.
   */
  it('has one writer of an article body, in the generation pipeline', () => {
    const repo = readFileSync(ARTICLES_REPO, 'utf8')
    const writers = [...repo.matchAll(/export async function (\w+)/g)]
      .map((m) => m[1]!)
      .filter((name) => {
        const start = repo.indexOf(`export async function ${name}`)
        const end = repo.indexOf('\nexport ', start + 1)
        const body = repo.slice(start, end === -1 ? undefined : end)
        // Writes only — `bodyJson` appearing in a `select` is a read, and
        // reading an article is not editing one.
        return body.includes('bodyJson:') && (body.includes('.set(') || body.includes('.values('))
      })
    expect(writers).toEqual(['saveDraftBody'])

    const callers = sourceFiles(join(repoRoot, 'packages'))
      .concat(sourceFiles(join(repoRoot, 'apps', 'web', 'app')))
      .filter((file) => file !== ARTICLES_REPO)
      .filter((file) => /\bsaveDraftBody\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(repoRoot, file))
      .filter((path) => !path.includes('/repositories/index.ts'))

    for (const caller of callers) {
      expect(caller.startsWith('packages/jobs/src/generation/'), `${caller} writes an article body`).toBe(true)
    }
  })
})
