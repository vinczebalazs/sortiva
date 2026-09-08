import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTES, UNCONTRACTED_ROUTES } from '@sortiva/core'
// Deep import, not the barrel: this module reads the filesystem, and the barrel
// is pulled into browser bundles.
import { patternFor, routesOnDisk } from '@sortiva/core/api/routes-on-disk'
import {
  createOpportunityActions,
  httpOpportunitiesApi,
  type ActionSurface,
} from '@sortiva/ui/opportunities/actions'
import type { OpportunityRow } from '@sortiva/ui/opportunities/types'
import {
  createCalendarActions,
  httpCalendarApi,
  type CalendarSurface,
} from '@sortiva/ui/content/actions'
import type { CalendarTopic } from '@sortiva/ui/content/types'
import { describe, expect, it } from 'vitest'

/**
 * Every address a screen sends a request to, checked against the contract and
 * against the route files that actually exist.
 *
 * This is the check whose absence let the Opportunities screen spend its whole
 * life posting to three addresses nobody had built — Undo asking for `restore`
 * where the route is `undismiss`, and two presses addressed to the opportunity
 * where the endpoints were built under `/api/recommendations`. Nothing went
 * red, because the only thing that ever answered those addresses was a stand-in
 * server written beside the screen.
 *
 * So the addresses are collected by *driving the presses*, through the same
 * client the browser uses, rather than by reading strings out of the source. An
 * address assembled at run time from a base and a fragment — which is how all
 * three were built — is invisible to a reader and obvious to a recorder.
 *
 * Both halves matter and they fail separately. The contract can declare an
 * endpoint nobody built (that is how ten screens came to have no server), and a
 * route can exist that the contract never described.
 */

const here = dirname(fileURLToPath(import.meta.url))
const apiRoot = join(here, '..', '..', 'api')
const served = routesOnDisk(apiRoot)

/**
 * The walk, the method reading and the address matching all come from one
 * place, shared with `pnpm contracts:check`, which needs the same answer to the
 * same question. Two copies of "what does this application serve" is how the
 * two ends of a check come to disagree without either being wrong.
 */

const METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const

/**
 * Redirects, file downloads and the identity library's own routes are
 * deliberately outside the JSON contract, and named in a list of their own so
 * that "not in the table" and "nobody built it" stop looking identical. They
 * are still real addresses, and a screen is allowed to send to one. Each is
 * written either as `METHOD /path` or as a bare path standing for every method.
 */
function uncontracted(): { method: string; path: string }[] {
  return UNCONTRACTED_ROUTES.flatMap((route) => {
    const [first = '', second] = route.path.split(' ')
    return second === undefined
      ? METHODS.map((method) => ({ method: method as string, path: first }))
      : [{ method: first, path: second }]
  })
}

const declared = [
  ...ROUTES.map((route) => ({ method: route.method as string, path: route.path })),
  ...uncontracted(),
].map((route) => ({
  ...route,
  pattern: patternFor(route.path),
}))

interface Verdict {
  readonly address: string
  readonly declaredAs: string | null
  readonly onDisk: boolean
}

/** What the contract and the filesystem each say about one address a screen sent. */
function verdictFor(sent: string): Verdict {
  const [method = '', withQuery = ''] = sent.split(' ')
  const pathname = withQuery.split('?')[0] ?? ''
  const found = declared.find((route) => route.method === method && route.pattern.test(pathname))
  if (!found) return { address: sent, declaredAs: null, onDisk: false }

  // A family named with a trailing `*` — the identity library's own routes —
  // counts as served if anything under it is.
  const onDisk = found.path.endsWith('/*')
    ? [...served].some((entry) => entry.startsWith(`${found.method} ${found.path.slice(0, -1)}`))
    : served.has(`${found.method} ${found.path}`)

  return { address: sent, declaredAs: `${found.method} ${found.path}`, onDisk }
}

// ── The presses ──────────────────────────────────────────────────────────────

const RECOMMENDATION_ID = '55555555-5555-4555-8555-555555555555'

/**
 * Every request the screen makes, in the order it made them, recorded off the
 * real client rather than described.
 *
 * Each answer succeeds and carries enough for the press to carry on, which
 * matters more than it looks: marking work applied reads the recommendation's
 * own id first and abandons the press if there is none, so an empty answer
 * would record the read and never record the write — and the check would pass
 * by never reaching the address it exists to inspect.
 */
function recorder(): { fetch: typeof fetch; sent: string[] } {
  const sent: string[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(`${(init?.method ?? 'GET').toUpperCase()} ${String(input)}`)
    return new Response(
      JSON.stringify({ ok: true, recommendation: { id: RECOMMENDATION_ID, state: 'ready' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  return { fetch: impl, sent }
}

const silentOpportunitySurface: ActionSurface = {
  toast: () => {},
  refresh: () => {},
  setHidden: () => {},
  setBusy: () => {},
}

const silentCalendarSurface: CalendarSurface = {
  toast: () => {},
  refresh: () => {},
  setHidden: () => {},
  setBusy: () => {},
  refuse: () => {},
}

const OPPORTUNITY_ID = '22222222-2222-4222-8222-222222222222'
const TASK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const row = { id: OPPORTUNITY_ID, signalType: 'striking_distance' } as OpportunityRow

/** Planned, unpinned and in the future, so every calendar press is allowed to reach the network. */
const topic: CalendarTopic = {
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Best trail shoes for wide feet',
  scheduledFor: '2026-09-25',
  state: 'planned',
  intentClass: 'buying_guide',
  kind: 'new',
  source: 'auto',
  pinned: false,
  targetKeyword: 'trail shoes wide feet',
  monthlySearchVolume: 880,
  why: { templateKey: 'uncovered_commercial_query.create', params: { volume: 880 } },
  opportunityId: '44444444-4444-4444-8444-444444444444',
  signalType: 'uncovered_commercial_query',
  articleId: null,
  rejection: null,
}

/**
 * The Opportunities screen: dismiss and the undo behind it, schedule, generate
 * page advice, mark one task applied, decline one task, mark the whole
 * recommendation applied.
 */
async function opportunityAddresses(): Promise<string[]> {
  const net = recorder()
  const client = httpOpportunitiesApi(net.fetch)
  const actions = createOpportunityActions(client, {
    ...silentOpportunitySurface,
    toast: (toast) => toast.onUndo?.(),
  })

  await client.list()
  await client.detail(OPPORTUNITY_ID)
  await actions.dismiss(row)
  await actions.schedule(row)
  await actions.generate(row)
  await actions.markTask(row, TASK_ID)
  await actions.skipTask(row, TASK_ID)
  await actions.applyAll(row)
  // The undo fires from inside the dismiss toast, so it lands a tick later.
  await new Promise((resolve) => setTimeout(resolve, 0))
  return net.sent
}

/** The Content calendar, which also reaches an opportunity when a day is called off. */
async function calendarAddresses(): Promise<string[]> {
  const net = recorder()
  const client = httpCalendarApi(net.fetch)
  const actions = createCalendarActions(client, silentCalendarSurface, { undoMs: 0 })

  await client.load('2026-09-01', '2026-09-30')
  await actions.veto(topic)
  await actions.flush()
  await actions.move(topic, '2026-09-26', null, '2026-09-07')
  await actions.pin(topic, true)
  await actions.add({ title: 'winter fell running', date: '2026-09-26', pin: false })
  return net.sent
}

describe('every address a screen sends a request to', () => {
  /**
   * Named in full, because the two checks below can only inspect addresses that
   * were actually sent: a press that quietly stops sending anything would leave
   * them passing over a shorter list.
   */
  it('is every press the Opportunities screen offers, and no other', async () => {
    expect(await opportunityAddresses()).toEqual([
      'GET /api/opportunities',
      `GET /api/opportunities/${OPPORTUNITY_ID}`,
      `POST /api/opportunities/${OPPORTUNITY_ID}/dismiss`,
      // The undo offered alongside the dismiss toast, taken here as soon as it
      // is offered. This is the press that used to ask for `restore`.
      `POST /api/opportunities/${OPPORTUNITY_ID}/undismiss`,
      `POST /api/opportunities/${OPPORTUNITY_ID}/schedule`,
      'POST /api/recommendations',
      // Marking work applied finds the recommendation first; the id is what the
      // route is addressed by, and only this read publishes it.
      `GET /api/recommendations?opportunityId=${OPPORTUNITY_ID}`,
      `POST /api/recommendations/${RECOMMENDATION_ID}/apply`,
      `GET /api/recommendations?opportunityId=${OPPORTUNITY_ID}`,
      // Declining a task has its own address. Pointing it at `apply` would
      // record a task the merchant refused as one they did.
      `POST /api/recommendations/${RECOMMENDATION_ID}/skip`,
      `GET /api/recommendations?opportunityId=${OPPORTUNITY_ID}`,
      `POST /api/recommendations/${RECOMMENDATION_ID}/apply`,
    ])
  })

  it('is one the contract declares', async () => {
    const sent = [...(await opportunityAddresses()), ...(await calendarAddresses())]
    expect(sent.length).toBeGreaterThan(0)

    const undeclared = sent.map(verdictFor).filter((verdict) => verdict.declaredAs === null)
    expect(
      undeclared.map((verdict) => verdict.address),
      'a screen is sending to an address the frozen route table does not declare',
    ).toEqual([])
  })

  it('is one a route file on disk actually serves', async () => {
    const sent = [...(await opportunityAddresses()), ...(await calendarAddresses())]

    const unserved = sent.map(verdictFor).filter((verdict) => !verdict.onDisk)
    expect(
      unserved.map((verdict) => verdict.address),
      'a screen is sending to an address no route file serves — on a deployed server this 404s ' +
        'and the screen shows its failure or its empty state',
    ).toEqual([])
  })

  it('would name the three addresses this screen used to send to', () => {
    // The exact strings the Opportunities screen posted until this card. Kept
    // as the check's own proof: a check that cannot fail is not a check, and
    // these are the failures it exists to produce.
    const gone = [
      `POST /api/opportunities/${OPPORTUNITY_ID}/restore`,
      `POST /api/opportunities/${OPPORTUNITY_ID}/recommendations`,
      `POST /api/opportunities/${OPPORTUNITY_ID}/tasks/${TASK_ID}`,
    ]
    for (const address of gone) {
      const verdict = verdictFor(address)
      expect(verdict.declaredAs, `${address} should be undeclared`).toBeNull()
      expect(verdict.onDisk, `${address} should be served by nothing`).toBe(false)
    }
  })

  it('reads the route files rather than trusting the contract about them', () => {
    // If this ever finds nothing, the two checks above pass vacuously and the
    // whole file becomes a contract check wearing a filesystem check's clothes.
    expect(served.size).toBeGreaterThan(30)
    expect(served.has('POST /api/opportunities/{id}/undismiss')).toBe(true)
    expect(served.has('POST /api/recommendations/{id}/apply')).toBe(true)
    expect(served.has('POST /api/recommendations/{id}/skip')).toBe(true)
  })
})
