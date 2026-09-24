import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTES, routeKey, type RouteDefinition } from '@sortiva/core'
import { describe, expect, it, vi } from 'vitest'

/**
 * Every field a screen reads out of an endpoint's answer, held against the
 * answer that endpoint actually gives.
 *
 * Two of the three sides of this are already checked. One proves every address
 * a screen sends to is one a route serves; the other proves every route's
 * answer matches the shape it declares. Neither can see a screen reaching for a
 * field that is not in the answer — which is how the Connect Search Console
 * button came to read `url` from an endpoint that sends `redirectUrl`, and it
 * was found by a person reading the screen by hand.
 *
 * So the reads are collected by *running the screen*: the real component, its
 * real click handlers and its real network calls, with every answer handed back
 * as a recording stand-in that notes each field the screen touches and whether
 * the answer carries it. Nothing here re-describes a screen, and nothing reads
 * `body.something` out of the source — a read assembled from a variable, or one
 * behind a `??`, is invisible to a reader and plain to a recorder.
 */

// ── The hooks a screen needs to run outside a browser ─────────────────────────

/**
 * Slots per component instance, kept across the render passes below so that
 * state a handler set is still there on the next pass.
 */
const instanceSlots = new Map<string, unknown[]>()
let slots: unknown[] = []
let cursor = 0
let pendingEffects: { readonly instance: string; readonly effect: () => unknown }[] = []
const ranEffects = new Set<string>()
let currentInstance = ''

/**
 * React's own hooks need a renderer underneath them; there is none here and no
 * DOM to put one in. These are the six this product's screens use, with the
 * semantics a single pass needs: state that survives between passes, effects
 * collected and run once, memo and callback computed every time.
 */
vi.mock('next/headers', () => ({
  headers: async () => new Map([['host', 'localhost:3000'], ['x-forwarded-proto', 'http']]),
  cookies: async () => new Map(),
}))

vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('redirected')
  },
  notFound: () => {
    throw new Error('not found')
  },
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('react', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const slot = <T,>(initial: T): number => {
    const index = cursor++
    if (index >= slots.length) {
      slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
    }
    return index
  }
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = slot(initial)
      // The setter has to hold on to *this* component's slots: the module-level
      // array below is swapped as the walk moves through the tree, so reading
      // it when the press fires would reach into whatever rendered last.
      const own = slots
      return [
        own[index],
        (next: unknown) => {
          own[index] = typeof next === 'function' ? (next as (p: unknown) => unknown)(own[index]) : next
        },
      ]
    },
    useRef: (initial: unknown) => {
      const index = cursor++
      if (index >= slots.length) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect: (effect: () => unknown) => {
      pendingEffects.push({ instance: `${currentInstance}#${cursor++}`, effect })
    },
    useLayoutEffect: (effect: () => unknown) => {
      pendingEffects.push({ instance: `${currentInstance}#${cursor++}`, effect })
    },
    useCallback: (fn: unknown) => fn,
    useMemo: (fn: () => unknown) => fn(),
    useContext: (context: { _currentValue?: unknown }) => context._currentValue,
  }
})

// ── Running a screen ─────────────────────────────────────────────────────────

const ELEMENT = Symbol.for('react.transitional.element')
const LEGACY_ELEMENT = Symbol.for('react.element')

interface ReactNodeish {
  readonly $$typeof?: symbol
  readonly type?: unknown
  readonly props?: Record<string, unknown>
}

function isElement(node: unknown): node is Required<ReactNodeish> {
  if (node === null || typeof node !== 'object') return false
  const marker = (node as ReactNodeish).$$typeof
  return marker === ELEMENT || marker === LEGACY_ELEMENT
}

interface Pass {
  /** Handlers found on this pass, in the order they were rendered. */
  readonly handlers: { readonly name: string; readonly fn: (...args: unknown[]) => unknown }[]
  rendered: number
}

/**
 * Where a render stopped, gathered across the whole of one drive.
 *
 * A component that throws returns no tree, so everything below it is never
 * walked and not one of its reads is seen. Letting that pass quietly is how a
 * check comes to claim more ground than it covers, which is the fault this file
 * exists to end — so the suite holds this list against what each pass is
 * entitled to: nothing at all on the answer as sent, and a named, reasoned list
 * on the emptied one.
 */
const renderStops: string[] = []

/**
 * Renders one element tree by calling every function component in it, which is
 * all a field read needs: the read happens in the component's own body, or in a
 * handler this collects on the way past.
 */
async function walk(node: unknown, path: string, pass: Pass, depth: number): Promise<void> {
  if (depth > 60 || node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const [index, child] of node.entries()) await walk(child, `${path}/${index}`, pass, depth + 1)
    return
  }
  if (!isElement(node)) return

  const { type, props } = node
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key.startsWith('on') && typeof value === 'function') {
      pass.handlers.push({ name: `${path}.${key}`, fn: value as () => unknown })
    }
  }

  if (typeof type === 'function') {
    const here = `${path}/${(type as { name?: string }).name ?? 'anonymous'}`
    const previousSlots = slots
    const previousCursor = cursor
    const previousInstance = currentInstance
    slots = instanceSlots.get(here) ?? []
    instanceSlots.set(here, slots)
    cursor = 0
    currentInstance = here
    let output: unknown
    try {
      output = (type as (p: unknown) => unknown)(props)
      pass.rendered += 1
    } catch (error) {
      renderStops.push(`${here}: ${(error as Error).message}`)
      output = null
    } finally {
      slots = previousSlots
      cursor = previousCursor
      currentInstance = previousInstance
    }
    // A server component is an async function; what it returns is a promise of
    // its tree, and everything inside it would be invisible without this.
    if (output instanceof Promise) {
      try {
        output = await output
      } catch (error) {
        renderStops.push(`${here}: ${(error as Error).message}`)
        output = null
      }
    }
    await walk(output, here, pass, depth + 1)
    return
  }

  await walk(props?.children, path, pass, depth + 1)
}

function pass(): Pass {
  return { handlers: [], rendered: 0 }
}

/**
 * A screen, run.
 *
 * Three rounds of render → effects → every press, because a control's handler
 * closes over the state of the render it came from: the first round types into
 * the field, and the press that reads what was typed is the one rendered after.
 */
async function run(element: unknown): Promise<Pass> {
  const all: Pass = pass()
  pendingEffects = []
  for (let round = 0; round < 3; round += 1) {
    const current = pass()
    await walk(element, '', current, 0)
    all.handlers.push(...current.handlers)
    all.rendered += current.rendered
    await settleEffects()
    for (const handler of current.handlers) {
      try {
        await handler.fn(syntheticEvent())
      } catch {
        // A press that fails is still a press that read; what it read is
        // recorded on the way through and the outcome is not this file's
        // business.
      }
    }
    await settleEffects()
  }
  return all
}

async function settleEffects(): Promise<void> {
  for (let round = 0; round < 4 && pendingEffects.length > 0; round += 1) {
    const queued = pendingEffects
    pendingEffects = []
    for (const { instance, effect } of queued) {
      if (ranEffects.has(instance)) continue
      ranEffects.add(instance)
      try {
        await effect()
      } catch {
        // Same as a handler: what it read is recorded either way.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

// ── Recording what a screen reads ────────────────────────────────────────────

interface Read {
  /** `METHOD /api/path` — the endpoint whose answer was read. */
  readonly route: string
  /** Dotted path into the answer; `[]` stands for "each of these". */
  readonly path: string
  /** Whether the answer actually carries it. */
  readonly present: boolean
}

let reads: Read[] = []

/**
 * Keys a runtime asks about rather than a screen reading data: awaiting a value
 * looks for `then`, serialising looks for `toJSON`, and this file's own renderer
 * looks for `$$typeof` on anything it is handed.
 */
const PROBES = new Set([
  'then',
  'toJSON',
  'constructor',
  'valueOf',
  'toString',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  '$$typeof',
  '_owner',
  'nodeType',
  'inspect',
])

const ARRAY_MEMBERS = new Set(Object.getOwnPropertyNames(Array.prototype))

/** `a` then `b` reads as `a.b`; the root of an answer has no name of its own. */
function fieldPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`
}

/**
 * The answer, handed to the screen as itself with a note taken of every field
 * it touches. Reading a field the answer does not carry is recorded rather than
 * refused, because a screen that copes with a missing field is exactly the case
 * this exists to find.
 */
function recording(value: unknown, route: string, path: string): unknown {
  if (value === null || typeof value !== 'object') return value
  return new Proxy(value as object, {
    get(target, key, receiver) {
      if (typeof key === 'symbol') return Reflect.get(target, key, receiver)
      if (Array.isArray(target)) {
        if (ARRAY_MEMBERS.has(key)) return Reflect.get(target, key, receiver)
        return recording(Reflect.get(target, key, receiver), route, `${path}[]`)
      }
      if (PROBES.has(key)) return Reflect.get(target, key, receiver)
      const at = fieldPath(path, key)
      reads.push({ route, path: at, present: key in target })
      return recording(Reflect.get(target, key, receiver), route, at)
    },
    has(target, key) {
      if (typeof key !== 'symbol' && !Array.isArray(target) && !PROBES.has(key)) {
        reads.push({ route, path: fieldPath(path, key), present: key in target })
      }
      return Reflect.has(target, key)
    },
  })
}

// ── What each endpoint answers ───────────────────────────────────────────────

/**
 * The answer an endpoint gives, parsed through that endpoint's own declared
 * schema so that anything the declaration does not know about is stripped
 * before a screen ever sees it.
 *
 * That parse is what makes this a check of the contract rather than of a mock:
 * a field somebody added to a fixture and to a screen, and to no endpoint,
 * disappears here and the screen's read of it is recorded as reaching for
 * nothing. The sibling suite that drives the real route files against the real
 * database is what holds the other end — that a route's answer really is what
 * it declares.
 */
const answers = new Map<string, unknown>()

async function answerFor(route: RouteDefinition): Promise<unknown> {
  const key = routeKey(route)
  if (!answers.has(key)) {
    const { fixtureFor } = await import('@sortiva/ui/msw')
    answers.set(key, route.response.parse(fixtureFor(route)))
  }
  return answers.get(key)
}

/**
 * Whether an endpoint's declaration can carry a field at all.
 *
 * A field missing from the answer this file drove a screen with is not yet a
 * fault: it may be one the declaration allows and this particular answer had no
 * value for, and some parts of an answer are open maps whose keys are whatever
 * the thing being described needs — the values a sentence fills its blanks
 * from, for one. Both would read as "the endpoint does not send this" and
 * neither is wrong.
 *
 * So the declaration is asked rather than read. A key is planted at that spot
 * in the answer and the whole thing is parsed with the endpoint's own schema:
 * what survives is what that endpoint is allowed to send. A made-up name that
 * survives means the spot is an open map and any key belongs there; a real name
 * that survives means the field is declared and merely absent today. A name
 * that is stripped is one no answer from this endpoint can ever carry, and that
 * is the fault this file exists to find.
 */
const OPEN_MAP_PROBE = 'zz_probe_key_9f1'
// A well-formed identifier belongs here alongside the loose values: a field
// declared as one rejects `'probe'`, so without this any absent read of an
// identifier looks like a field its endpoint could never send. Added when
// naming the dashboard's reference keys turned a real fix into a false alarm.
const PROBE_VALUES: readonly unknown[] = [
  'probe',
  '00000000-0000-4000-8000-000000000000',
  1,
  true,
  null,
  {},
  [],
]

function plant(body: unknown, segments: readonly string[], key: string, value: unknown): boolean {
  if (body === null || typeof body !== 'object') return false
  if (segments.length === 0) {
    ;(body as Record<string, unknown>)[key] = value
    return true
  }
  const [head = '', ...rest] = segments
  if (head.endsWith('[]')) {
    const list = (body as Record<string, unknown>)[head.slice(0, -2)]
    if (!Array.isArray(list) || list.length === 0) return false
    return list.some((entry) => plant(entry, rest, key, value))
  }
  return plant((body as Record<string, unknown>)[head], rest, key, value)
}

function survives(body: unknown, segments: readonly string[], key: string): boolean {
  if (body === null || typeof body !== 'object') return false
  if (segments.length === 0) return key in (body as Record<string, unknown>)
  const [head = '', ...rest] = segments
  if (head.endsWith('[]')) {
    const list = (body as Record<string, unknown>)[head.slice(0, -2)]
    return Array.isArray(list) && list.some((entry) => survives(entry, rest, key))
  }
  return survives((body as Record<string, unknown>)[head], rest, key)
}

const carryable = new Map<string, boolean>()

async function canCarry(routeKeyOf: string, path: string): Promise<boolean> {
  const cached = carryable.get(`${routeKeyOf} ${path}`)
  if (cached !== undefined) return cached

  const route = ROUTES.find((candidate) => routeKey(candidate) === routeKeyOf)
  const { fixtureFor } = await import('@sortiva/ui/msw')
  const segments = path.split('.')
  const key = segments.pop() ?? ''
  const parent = segments

  const withKey = (name: string, value: unknown): boolean => {
    if (!route) return false
    const clone = structuredClone(fixtureFor(route)) as unknown
    if (!plant(clone, parent, name, value)) return false
    const parsed = route.response.safeParse(clone)
    return parsed.success && survives(parsed.data, parent, name)
  }

  const open = PROBE_VALUES.some((value) => withKey(OPEN_MAP_PROBE, value))
  const answer = open || PROBE_VALUES.some((value) => withKey(key, value))
  carryable.set(`${routeKeyOf} ${path}`, answer)
  return answer
}

/** A declared address as a matcher: `{id}` stands for one path segment. */
function patternFor(path: string): RegExp {
  const source = path
    .split(/\{[^}]+\}/)
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('([^/]+)')
  return new RegExp(`^${source}$`)
}

const matchers = ROUTES.map((route) => ({ route, pattern: patternFor(route.path) }))

/** Addresses a screen sent that no route in the contract declares. */
let unmatched: string[] = []

/** Every address a driven screen actually sent to, so a driver that ran nothing says so. */
let requests: string[] = []

/**
 * The same answer with every value emptied out, and every field still known to
 * be there or not.
 *
 * A recorder can only see a read that happens, and the read that matters most
 * is the one that does not: `body.url ?? body.redirectUrl` never touches the
 * second name while the first has a value, which is precisely why a screen
 * hedging between two spellings for one field reported nothing for months while
 * the button beside it was broken.
 *
 * So every screen is driven a second time against an answer that carries the
 * same fields holding nothing. Every fallback, every `??` and every `if (!x)`
 * then runs, and a read of a name the endpoint does not have is recorded — from
 * a branch the happy path never reaches.
 */
function blank(value: unknown, route: string, path: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    return new Proxy(value, {
      get(target, key, receiver) {
        if (typeof key === 'symbol' || ARRAY_MEMBERS.has(key)) return Reflect.get(target, key, receiver)
        return blank(Reflect.get(target, key, receiver), route, `${path}[]`)
      },
    })
  }
  return new Proxy(value as object, {
    get(target, key, receiver) {
      if (typeof key === 'symbol') return Reflect.get(target, key, receiver)
      if (PROBES.has(key)) return Reflect.get(target, key, receiver)
      const at = fieldPath(path, key)
      reads.push({ route, path: at, present: key in target })
      return blank(Reflect.get(target, key, receiver), route, at)
    },
    has(target, key) {
      if (typeof key !== 'symbol' && !PROBES.has(key)) {
        reads.push({ route, path: fieldPath(path, key), present: key in target })
      }
      return Reflect.has(target, key)
    },
  })
}

type Fill = 'as sent' | 'emptied'

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

/**
 * The network, answering every declared address with that endpoint's own
 * answer. Nothing else answers: an address the contract does not declare gets a
 * 404 and is named, because a screen reading fields off an endpoint that does
 * not exist is the neighbouring check's finding rather than this one's.
 */
function network(fill: Fill): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const pathname = raw.startsWith('http') ? new URL(raw).pathname : (raw.split('?')[0] ?? '')
    requests.push(`${method} ${pathname}`)
    const found = matchers.find((entry) => entry.route.method === method && entry.pattern.test(pathname))
    if (!found) {
      unmatched.push(`${method} ${pathname}`)
      return fakeResponse(404, { error: { code: 'not_found', message: 'No such route.' } })
    }
    const key = routeKey(found.route)
    const answer = await answerFor(found.route)
    const body = fill === 'as sent' ? recording(answer, key, '') : blank(answer, key, '')
    return fakeResponse(found.route.status ?? 200, body)
  }) as typeof fetch
}

/**
 * Props a screen was handed by its page, which the page read from an endpoint.
 * Recorded the same way, because a page passing a whole response down means the
 * read happens in the component rather than in the page.
 */
let propsFill: Fill = 'as sent'

async function answerProps(key: string): Promise<unknown> {
  const route = ROUTES.find((candidate) => routeKey(candidate) === key)
  if (!route) throw new Error(`No route ${key} to take props from`)
  const answer = await answerFor(route)
  return propsFill === 'as sent' ? recording(answer, key, '') : blank(answer, key, '')
}

// ── The screens ──────────────────────────────────────────────────────────────

interface ScreenDriver {
  /** The screen, by the name the UI spec uses. */
  readonly screen: string
  /** Source files whose reads this driver exercises, relative to the repo root. */
  readonly modules: readonly string[]
  readonly run: () => Promise<void>
}

/**
 * The day the answers below describe, asked of the fixtures rather than
 * repeated here.
 *
 * Every screen is driven as if it were that day, because a calendar or a chart
 * drawn around a different "today" has no cell for any of this to land in: it
 * draws an empty grid, and every read that would have happened inside a chip
 * that was never drawn goes unseen. Repeating the date here would let the
 * fixtures move and take that coverage away in silence.
 */
async function fixtureToday(): Promise<Date> {
  const { FIXTURE_NOW } = await import('@sortiva/ui/msw')
  return new Date(FIXTURE_NOW)
}

/** A press hands its handler a synthetic event carrying something typeable. */
const TYPED = 'example-outdoor.com'

async function ui(): Promise<typeof import('@sortiva/ui')> {
  return import('@sortiva/ui')
}

async function element(name: keyof typeof import('@sortiva/ui'), props: unknown): Promise<unknown> {
  const { createElement } = await import('react')
  const module = (await ui()) as unknown as Record<string, unknown>
  const component = module[name as string]
  if (typeof component !== 'function') throw new Error(`@sortiva/ui exports no component ${String(name)}`)
  return createElement(component as never, props as never)
}

/**
 * A page, run the way the server runs it: the real default export, its real
 * reads through the real loader, and then the tree it returns.
 *
 * The screens underneath are handed the answer itself, so a page that passes a
 * whole response down is where most of a screen's field reads are recorded.
 */
async function page(specifier: string, props: unknown = {}): Promise<void> {
  // The app's own files are compiled with the classic JSX transform, which
  // calls `React.createElement` off the global rather than importing it.
  ;(globalThis as { React?: unknown }).React = await import('react')
  const module = (await import(/* @vite-ignore */ specifier)) as { default: (p: unknown) => unknown }
  const tree = await module.default(props)
  await run(tree)
}

const DRIVERS: readonly ScreenDriver[] = [
  {
    screen: 'Opportunities — the list and the drawer over it',
    modules: [
      'apps/web/app/(app)/opportunities/page.tsx',
      'apps/web/app/(app)/_lib/api.ts',
      'packages/ui/src/opportunities/actions.ts',
    ],
    run: async () => {
      await page('../opportunities/page')
    },
  },
  {
    screen: 'Content — the calendar',
    modules: ['apps/web/app/(app)/content/page.tsx', 'packages/ui/src/content/actions.ts'],
    run: async () => {
      await page('../content/page', { searchParams: Promise.resolve({}) })
    },
  },
  {
    screen: 'Content — the articles library',
    modules: ['apps/web/app/(app)/content/articles/page.tsx'],
    run: async () => {
      await page('../content/articles/page', { searchParams: Promise.resolve({}) })
    },
  },
  {
    screen: 'Content — one article',
    modules: [
      'apps/web/app/(app)/content/articles/[articleId]/page.tsx',
      'packages/ui/src/content/ArticleDetail.tsx',
      'packages/ui/src/content/export.ts',
    ],
    run: async () => {
      await page('../content/articles/[articleId]/page', {
        params: Promise.resolve({ articleId: '66666666-6666-4666-8666-666666666666' }),
      })
    },
  },
  {
    screen: 'Dashboard',
    modules: ['apps/web/app/(app)/dashboard/page.tsx', 'apps/web/app/(app)/dashboard/SteadyState.tsx'],
    run: async () => {
      await page('../dashboard/page', { searchParams: Promise.resolve({}) })
    },
  },
  {
    screen: 'Products',
    modules: ['apps/web/app/(app)/products/page.tsx'],
    run: async () => {
      await page('../products/page', { searchParams: Promise.resolve({}) })
    },
  },
  {
    screen: 'Performance — the chart and the results table',
    modules: ['apps/web/app/(app)/performance/page.tsx'],
    run: async () => {
      await page('../performance/page', { searchParams: Promise.resolve({}) })
    },
  },
  {
    screen: 'Performance — the Search Console page',
    modules: ['apps/web/app/(app)/performance/search-console/page.tsx'],
    run: async () => {
      await page('../performance/search-console/page', { searchParams: Promise.resolve({}) })
    },
  },
  {
    screen: 'Settings — Connections, as the page assembles it',
    modules: ['apps/web/app/(app)/settings/connections/page.tsx'],
    run: async () => {
      await page('../settings/connections/page', { searchParams: Promise.resolve({ gsc: 'granted' }) })
    },
  },
  {
    screen: 'Settings — Account, as the page assembles it',
    modules: ['apps/web/app/(app)/settings/account/page.tsx'],
    run: async () => {
      await page('../settings/account/page', { searchParams: Promise.resolve({}) })
    },
  },
  {
    screen: 'Settings — Publishing, as the page assembles it',
    modules: ['apps/web/app/(app)/settings/publishing/page.tsx'],
    run: async () => {
      await page('../settings/publishing/page', { searchParams: Promise.resolve({}) })
    },
  },
  {
    screen: 'Settings — Store profile',
    modules: [
      'apps/web/app/(app)/settings/profile/page.tsx',
      'packages/ui/src/onboarding/ConfirmationSections.tsx',
    ],
    run: async () => {
      await page('../settings/profile/page', { searchParams: Promise.resolve({}) })
    },
  },
  {
    screen: 'Onboarding — setup progress',
    modules: ['packages/ui/src/onboarding/useIngestionStatus.ts'],
    run: async () => {
      const { browserFollowDependencies } = await ui()
      const dependencies = browserFollowDependencies()
      const status = await dependencies.readStatus('/api/ingestion/status')
      // The status body is read field by field by the progress list; touching
      // it here is what records those reads without a browser to poll in.
      const body = status as unknown as { status?: unknown; startedAt?: unknown; steps?: unknown[] }
      void [body.status, body.startedAt]
      for (const step of body.steps ?? []) {
        const row = step as { step?: unknown; state?: unknown; startedAt?: unknown; attempts?: unknown }
        void [row.step, row.state, row.startedAt, row.attempts]
      }
    },
  },

  {
    screen: 'Settings — Connections',
    modules: ['packages/ui/src/settings/ConnectionsSettings.tsx'],
    run: async () => {
      await run(
        await element('ConnectionsSettings', {
          account: await answerProps('GET /api/account'),
          gscOutcome: 'granted',
          gscDisconnectEndpoint: '/api/gsc/property',
        }),
      )
      // The Shopify row only offers Reconnect once the connection is broken,
      // and that press is a different endpoint from the one above.
      const account = (await answerProps('GET /api/account')) as { connections: unknown }
      await run(
        await element('ConnectionsSettings', {
          account: { ...account, connections: { ...(account.connections as object), shopify: 'broken' } },
        }),
      )
    },
  },
  {
    screen: 'Onboarding — Search Console',
    modules: ['packages/ui/src/onboarding/SearchConsoleStep.tsx'],
    run: async () => {
      await run(await element('SearchConsoleStep', { initialPhase: 'picker' }))
      await run(await element('SearchConsoleStep', { initialPhase: 'connect' }))
    },
  },
  {
    screen: 'Onboarding — Shopify is not connected',
    modules: ['packages/ui/src/onboarding/ShopifyBlockingCard.tsx'],
    run: async () => {
      await run(await element('ShopifyBlockingCard', {}))
    },
  },
  {
    screen: 'Onboarding — finding your opportunities',
    modules: ['packages/ui/src/onboarding/FindingOpportunities.tsx'],
    run: async () => {
      await run(await element('FindingOpportunities', { pollMs: 1 }))
    },
  },
  {
    screen: 'Settings — Publishing',
    modules: ['packages/ui/src/settings/PublishingSettings.tsx'],
    run: async () => {
      await run(
        await element('PublishingSettings', {
          settings: await answerProps('GET /api/settings'),
          country: 'GB',
        }),
      )
    },
  },
  {
    screen: 'Settings — Account',
    modules: ['packages/ui/src/settings/AccountSettings.tsx'],
    run: async () => {
      await run(
        await element('AccountSettings', {
          settings: await answerProps('GET /api/settings'),
        }),
      )
    },
  },
  {
    screen: 'Shell — notification bell',
    modules: ['packages/ui/src/shell/NotificationBell.tsx'],
    run: async () => {
      await run(await element('NotificationBell', { pollMs: 1 }))
    },
  },
  {
    screen: 'Performance — the Search Console tab',
    modules: ['packages/ui/src/performance/SearchConsoleScreen.tsx'],
    run: async () => {
      const rows = await answerProps('GET /api/performance/search-console')
      await run(await element('SearchConsoleScreen', { queries: rows, pages: rows }))
    },
  },
  {
    screen: 'Landing — the preview form',
    modules: ['packages/ui/src/public/PreviewForm.tsx'],
    run: async () => {
      await run(await element('PreviewForm', { turnstileSiteKey: null }))
    },
  },
]

/**
 * What a press is handed. A screen whose control is a text field reads its
 * value off the event, so an empty one would submit nothing and the request
 * this exists to inspect would never be made.
 */
function syntheticEvent(): unknown {
  return {
    preventDefault: () => {},
    stopPropagation: () => {},
    target: { value: TYPED, checked: true },
    currentTarget: { value: TYPED, checked: true },
  }
}

// ── Screens this cannot drive, each with the reason ──────────────────────────

/**
 * Named rather than absent, so that "nothing checks this" and "nobody thought
 * about it" stop looking the same. The list is held against a scan of the
 * source below: a screen that reads an endpoint answer is either driven above
 * or named here.
 */
const UNDRIVEN: Readonly<Record<string, string>> = {
  'packages/ui/src/public/signin-exchange.ts':
    'reads the sign-in library\'s own two addresses, which are deliberately outside the JSON ' +
    'contract and have no declared answer here to hold a read against. What it reads is pinned ' +
    'instead by signin-exchange.test.ts, against the shapes that library documents.',
  'packages/ui/src/shell/signout.ts':
    'the same two addresses as signing in, and the same reason: the sign-out answer is the ' +
    'identity library\'s, not one this contract declares. Pinned by signout.test.ts.',
}

// ── Where the emptied pass runs out of screen ────────────────────────────────

/**
 * Screens whose second drive stops part way, and what each one costs.
 *
 * The second drive hands the screen the same answer with every value emptied
 * out, which is the only way to reach a fallback: `a.url ?? a.redirectUrl` never
 * touches the second name while the first has a value. Emptying values is
 * deliberately something no real endpoint does, so a component that formats a
 * number, looks a word up by a value, or maps over a list will throw the moment
 * it touches one — and a component that throws renders nothing, so the fallback
 * reads *below* it are never reached on that pass.
 *
 * None of this is a fault in the screen. What it is, is the exact edge of what
 * this file can say: on these screens, a hedge between two spellings sitting
 * underneath the named component would still go unnoticed. The first drive, on
 * the answer as really sent, reaches every one of them — so a field a screen
 * simply reads is covered everywhere; it is only the unreached branch that is
 * not.
 *
 * Held exactly, so that a screen which starts stopping has to be added with a
 * sentence, and one that stops stopping has to be taken out.
 */
const EMPTIED_PASS_STOPS: Readonly<Record<string, string>> = {
  'Opportunities — the list and the drawer over it':
    'a card\'s chip row and the drawer over it both stop on an emptied value, so the fallbacks ' +
    'in the rest of a card\'s chips and in the whole of the drawer body are not reached.',
  'Content — the articles library':
    'the library stops asking the copy catalogue for the word for an article state that is now ' +
    'blank, so the fallbacks in the list below it are not reached.',
  'Content — one article':
    'the same lookup stops the article page, so the fallbacks in the quality report, the task ' +
    'list and the export controls under it are not reached.',
  'Products':
    'the screen stops asking for the word for a product-richness band that is now blank, so the ' +
    'fallbacks in the family list under it are not reached.',
  'Performance — the Search Console page':
    'the results table stops formatting a number that is now blank, so the fallbacks in its rows ' +
    'are not reached.',
  'Performance — the Search Console tab':
    'the same table, driven directly rather than through its page, and the same stop.',
  'Settings — Connections, as the page assembles it':
    'the connections list stops asking for the word for a connection state that is now blank, so ' +
    'the fallbacks in the rows under it are not reached.',
  'Settings — Connections':
    'the same component driven directly rather than through its page, and the same stop.',
  'Settings — Store profile':
    'the competitors and families sections both stop — one on a word keyed by a value that is ' +
    'now blank, one on a list that is no longer a list — so the fallbacks under both are not ' +
    'reached.',
  'Shell — notification bell':
    'the bell stops having no line to show for a notification type that is now blank, so the ' +
    'fallbacks in the notification list are not reached.',
}

// ── The suite ────────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..', '..', '..')

/**
 * Every source file that reads an endpoint's answer: it either parses a
 * response itself, or reads one through the server-side loader every page uses.
 */
function modulesThatReadAnAnswer(): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const next = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue
        // Route handlers read the *request*, which is the other direction and
        // belongs to the check that drives routes against their declarations.
        if (relative(repoRoot, next) === join('apps', 'web', 'app', 'api')) continue
        walk(next)
        continue
      }
      if (!/\.tsx?$/.test(entry.name)) continue
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue
      const source = readFileSync(next, 'utf8')
      if (source.includes('.json()') || /\bgetJson[<(]/.test(source)) {
        found.push(relative(repoRoot, next))
      }
    }
  }
  walk(join(repoRoot, 'packages', 'ui', 'src'))
  walk(join(repoRoot, 'apps', 'web', 'app'))
  return found.sort()
}

interface DriverResult {
  readonly screen: string
  readonly reads: readonly Read[]
  readonly unmatched: readonly string[]
  /** Where the emptied pass stopped, if it did; see `EMPTIED_PASS_STOPS`. */
  readonly stoppedWhenEmptied: readonly string[]
}

const results: DriverResult[] = []

describe('every field a screen reads is one the endpoint sends', () => {
  for (const driver of DRIVERS) {
    it(`${driver.screen}`, async () => {
      const seen: Read[] = []
      const sent: string[] = []
      const stray: string[] = []
      const stoppedOnReal: string[] = []
      const stoppedWhenEmptied: string[] = []
      const today = await fixtureToday()
      for (const fill of ['as sent', 'emptied'] as const) {
        renderStops.length = 0
        reads = []
        unmatched = []
        requests = []
        instanceSlots.clear()
        ranEffects.clear()
        pendingEffects = []
        propsFill = fill
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(today)
        vi.stubGlobal('fetch', network(fill))
        vi.stubGlobal('window', { location: { assign: () => {}, href: '', origin: 'http://localhost:3000' } })
        try {
          await driver.run()
        } finally {
          vi.unstubAllGlobals()
          vi.useRealTimers()
          propsFill = 'as sent'
        }
        seen.push(...reads)
        sent.push(...requests)
        stray.push(...unmatched)
        ;(fill === 'as sent' ? stoppedOnReal : stoppedWhenEmptied).push(...new Set(renderStops))
      }
      results.push({ screen: driver.screen, reads: seen, unmatched: stray, stoppedWhenEmptied })

      expect(
        stoppedOnReal,
        `${driver.screen} stopped part way through rendering the answer its endpoints really ` +
          'send. Everything below that point was never rendered and none of its reads were seen, ' +
          'so this screen is covered less than the rest of this file claims.',
      ).toEqual([])

      expect(
        seen.length + sent.length,
        `${driver.screen} neither read a field nor sent a request, so this test passed over an ` +
          'empty list. Driving the screen has stopped working, or it no longer talks to the API.',
      ).toBeGreaterThan(0)

      const absent = [...new Set(seen.filter((read) => !read.present).map((read) => `${read.route}|${read.path}`))]
      const missing: string[] = []
      for (const entry of absent) {
        const [route = '', path = ''] = entry.split('|')
        if (await canCarry(route, path)) continue
        missing.push(`${route} cannot send ${path}`)
      }
      expect(
        missing,
        `${driver.screen} reads a field its endpoint does not send. On a deployed server that ` +
          'field is undefined, and the screen shows its empty state, its failure, or nothing at all.',
      ).toEqual([])
    }, 30_000)
  }

  it('read enough to be worth anything', () => {
    const total = results.reduce((count, result) => count + result.reads.length, 0)
    expect(
      total,
      'the screens above between them read almost nothing, which means they are not really being ' +
        'run and every check in this file is passing over an empty list',
    ).toBeGreaterThan(60)
  })

  it('says exactly which screens the emptied pass runs out of', () => {
    const stopping = results.filter((result) => result.stoppedWhenEmptied.length > 0).map((result) => result.screen)
    const undeclared = stopping.filter((screen) => EMPTIED_PASS_STOPS[screen] === undefined)
    expect(
      undeclared,
      'the emptied pass stopped part way through a screen nothing here admits to. Either the ' +
        'screen was made to survive an emptied answer, or this file is quietly covering less than ' +
        'it says — add it to EMPTIED_PASS_STOPS with what stopping there costs.',
    ).toEqual([])

    const overstated = Object.keys(EMPTIED_PASS_STOPS).filter((screen) => !stopping.includes(screen))
    expect(
      overstated,
      'a screen is recorded as one the emptied pass runs out of, and it no longer does. Delete ' +
        'the entry: an admission that is no longer true reads as a limit this file does not have.',
    ).toEqual([])

    const wordless = Object.entries(EMPTIED_PASS_STOPS)
      .filter(([, cost]) => cost.trim().length < 20)
      .map(([screen]) => screen)
    expect(wordless, 'naming a screen without saying what it costs is the same as skipping it').toEqual([])
  })

  it('sends only to addresses the contract declares', () => {
    const stray = [...new Set(results.flatMap((result) => result.unmatched))]
    expect(
      stray,
      'a screen driven here sent to an address the frozen route table does not declare, so this ' +
        'file could not tell it what that endpoint answers. The neighbouring address check owns ' +
        'the fault; this one is blind until it is fixed.',
    ).toEqual([])
  })
})

describe('the reader itself', () => {
  it('names a field the answer does not carry', () => {
    reads = []
    const body = recording({ url: 'https://accounts.google.com/o/oauth2/v2/auth' }, 'POST /api/gsc/oauth/start', '') as {
      redirectUrl?: string
    }
    // The read the Settings screen would have made if it had been written
    // against the handler rather than against the contract.
    void body.redirectUrl
    expect(reads.filter((read) => !read.present)).toEqual([
      { route: 'POST /api/gsc/oauth/start', path: 'redirectUrl', present: false },
    ])
  })

  it('sees a hedge between two spellings, which only the emptied answer reaches', () => {
    const hedge = (answer: unknown): unknown => {
      const body = answer as { url?: string; redirectUrl?: string }
      return body.url ?? body.redirectUrl
    }
    const real = { url: 'https://accounts.google.com/o/oauth2/v2/auth' }

    // As sent, the second spelling is never evaluated: `??` stops at the first
    // value. This is the whole reason the emptied pass exists — a recorder
    // cannot see a read that JavaScript never performs.
    reads = []
    hedge(recording(real, 'POST /api/gsc/oauth/start', ''))
    expect(reads.filter((read) => !read.present)).toEqual([])

    reads = []
    hedge(blank(real, 'POST /api/gsc/oauth/start', ''))
    expect(reads.filter((read) => !read.present)).toEqual([
      { route: 'POST /api/gsc/oauth/start', path: 'redirectUrl', present: false },
    ])
  })

  it('follows a field read through a list and through a nested object', () => {
    reads = []
    const answer = recording({ rows: [{ signals: [{ signalType: 'striking_distance' }] }] }, 'GET /api/x', '') as {
      rows: { signals: { signalType: string; opportunityId?: string }[] }[]
    }
    for (const row of answer.rows) for (const signal of row.signals) void [signal.signalType, signal.opportunityId]
    expect(reads.map((read) => `${read.path} ${read.present}`)).toEqual([
      'rows true',
      'rows[].signals true',
      'rows[].signals[].signalType true',
      'rows[].signals[].opportunityId false',
    ])
  })
})

describe('every screen that reads an answer is driven or named', () => {
  it('accounts for all of them', () => {
    const driven = new Set(DRIVERS.flatMap((driver) => driver.modules))
    const unaccounted = modulesThatReadAnAnswer().filter(
      (module) => !driven.has(module) && UNDRIVEN[module] === undefined,
    )
    expect(
      unaccounted,
      'a screen reads an endpoint answer and nothing here drives it — add a driver, or name it ' +
        'in UNDRIVEN with the reason it cannot be driven',
    ).toEqual([])
  })

  it('names nothing that has moved or gone', () => {
    const onDisk = new Set(modulesThatReadAnAnswer())
    const stale = [...DRIVERS.flatMap((driver) => driver.modules), ...Object.keys(UNDRIVEN)].filter(
      (module) => !onDisk.has(module),
    )
    expect(stale, 'a driver or an exception names a file that no longer reads an answer').toEqual([])
  })

  it('gives every screen it cannot drive a reason a person can read', () => {
    const wordless = Object.entries(UNDRIVEN)
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([module]) => module)
    expect(wordless, 'naming a screen without saying why is the same as skipping it').toEqual([])
  })
})
