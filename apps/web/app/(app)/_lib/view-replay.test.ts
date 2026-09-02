import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { browserAnalyticsInitOptions, sessionReplay, VIEW_CONTENT, viewContent } from '@sortiva/ui'

/**
 * Session replay records a film of the page and plays it back to us later, so a
 * replay of a merchant's screen is a copy of their catalogue held on a vendor's
 * servers. It is off, and this is the check that it stays off as the product
 * grows screens.
 *
 * Every view the app serves has to say whether it renders a merchant's store
 * data. A view nobody classified counts as store data, so a screen added
 * without a decision is off; this test is what makes someone make the decision
 * rather than inherit the default silently.
 */

/** The authenticated group this file sits in, and the routes folder above it. */
const authenticatedDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const appDir = join(authenticatedDir, '..')

/** Every route the app serves, worked out from where its `page.tsx` files sit. */
function routesOnDisk(dir: string = appDir): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      // `_lib` and friends are Next's private folders: never a route.
      if (entry.name.startsWith('_')) continue
      found.push(...routesOnDisk(path))
    } else if (entry.name === 'page.tsx') {
      found.push(routeOf(path))
    }
  }
  return found
}

/** `app/(public)/plan/page.tsx` is the route `/plan`; a folder in brackets groups files without naming a path. */
function routeOf(pagePath: string): string {
  const segments = relative(appDir, dirname(pagePath))
    .split(sep)
    .filter((segment) => segment.length > 0 && !segment.startsWith('('))
  return `/${segments.join('/')}`.replace(/\/$/, '') || '/'
}

const APP_ROUTES = routesOnDisk()

describe('every view says whether it renders a merchant’s store data', () => {
  it('finds the app’s routes at all, so an empty walk cannot pass this file', () => {
    expect(APP_ROUTES.length).toBeGreaterThan(0)
  })

  it('has a decision recorded for each one', () => {
    const undecided = APP_ROUTES.filter((route) => !(route in VIEW_CONTENT))
    expect(
      undecided,
      `Add these routes to VIEW_CONTENT in packages/ui/src/analytics/replay.ts, saying ` +
        `whether each renders a merchant's store data. Until then they count as store data ` +
        `and can never be recorded.`,
    ).toEqual([])
  })

  it('records no decisions for routes that no longer exist', () => {
    const stale = Object.keys(VIEW_CONTENT).filter((route) => !APP_ROUTES.includes(route))
    expect(stale).toEqual([])
  })
})

describe('replay is off on every view that renders store data', () => {
  const storeDataRoutes = APP_ROUTES.filter((route) => viewContent(route) === 'store_data')

  it('finds at least one such view, so this is not passing on an empty list', () => {
    expect(storeDataRoutes.length).toBeGreaterThan(0)
  })

  it('answers off for each of them, and starts the vendor library with recording disabled', () => {
    for (const route of storeDataRoutes) {
      expect(sessionReplay(route), route).toBe('off')
      expect(browserAnalyticsInitOptions(route).disable_session_recording, route).toBe(true)
    }
  })

  it('stays off for each of them even when replay is switched on for that exact route', () => {
    for (const route of storeDataRoutes) {
      expect(sessionReplay(route, storeDataRoutes), route).toBe('off')
    }
  })
})

describe('nothing in the product starts a recording', () => {
  const sources = sourceFiles(join(appDir, '..', '..', '..'))

  it('never calls the vendor’s start-recording method, and never re-enables it in a config', () => {
    const offenders = sources.filter((file) => {
      const text = readFileSync(file, 'utf8')
      return (
        text.includes('startSessionRecording') ||
        /disable_session_recording\s*:\s*false/.test(text)
      )
    })
    expect(offenders.map((file) => relative(join(appDir, '..', '..', '..'), file))).toEqual([])
  })
})

/** Every TypeScript source in the app and the shared component library, tests aside. */
function sourceFiles(repoRoot: string): string[] {
  const roots = [join(repoRoot, 'apps', 'web', 'app'), join(repoRoot, 'packages', 'ui', 'src')]
  const found: string[] = []
  for (const root of roots) walk(root, found)
  return found.filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
}

function walk(dir: string, into: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      walk(path, into)
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      into.push(path)
    }
  }
}

describe('the authenticated shell is where reporting is switched on', () => {
  it('mounts the provider, so a screen that asks for analytics gets a real one', () => {
    const layout = readFileSync(join(authenticatedDir, 'layout.tsx'), 'utf8')
    expect(layout).toContain('AnalyticsMount')
  })

  it('is the only place that does, so the public funnel is not reported twice', () => {
    // Every step of the public funnel is already recorded server-side as the
    // work happens. A browser-side copy would leave the funnel's numbers
    // depending on which of the two you counted, so the public pages load no
    // analytics library at all.
    const publicDir = join(appDir, '(public)')
    const mounting = []
    const files: string[] = []
    walk(publicDir, files)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      if (text.includes('AnalyticsMount') || text.includes('AnalyticsProvider')) {
        mounting.push(relative(appDir, file))
      }
    }
    expect(mounting).toEqual([])
  })
})
