import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { RESPONSE_FIXTURES } from '@sortiva/ui/msw/fixtures'
import { ContentState, articleDetail, articlesList } from './content-state'
import { declare, match, scaffolding, type MockRoute } from './contract-dispatch'
import { OnboardingState } from './onboarding-state'

/**
 * The site, with the API answered from fixtures.
 *
 * The public funnel is built against the mock server frozen with the API
 * contract, and the screens have to be driven in a real browser to prove the
 * flow works — a visitor pastes an address, reads the card, follows the teaser,
 * signs in, and leaves for Stripe. Two of those steps cannot run against the
 * real endpoints on a developer's machine: reading a stranger's website costs a
 * model call, and both Stripe and Google want credentials this repository does
 * not have.
 *
 * A browser-side intercept would not be enough, because the plan screen asks
 * for its price while it is being rendered on the server, where the browser
 * cannot see the request. So this sits in front of the app instead: anything
 * under `/api/` that has a fixture is answered here, and everything else —
 * every page — is passed through to the running app untouched. Both the browser
 * and the app's own server-side reads therefore get the same fixed answers.
 *
 * This is the same shape the Shopify and Search Console cards used: a real
 * local server standing in for the vendor, so the code under test is the code
 * that ships. It runs only under Playwright.
 */

const APP_ORIGIN = process.env.E2E_APP_ORIGIN ?? 'http://localhost:3000'
const PORT = Number(process.env.E2E_MOCK_PORT ?? 3100)

/** Addresses that make the preview answer with something other than a summary. */
const RATE_LIMITED_MARKER = 'ratelimited'
const UNREADABLE_MARKER = 'unreadable'

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encoded),
  })
  response.end(encoded)
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The preview, in each of the three answers the landing page has to handle. The
 * address decides which, so one flow can walk through all of them.
 */
function previewAnswer(response: ServerResponse, rawBody: string): void {
  let url = ''
  try {
    url = String((JSON.parse(rawBody) as { url?: unknown }).url ?? '')
  } catch {
    url = ''
  }

  if (url.includes(RATE_LIMITED_MARKER)) {
    json(response, 429, { error: { code: 'rate_limited', message: 'Too many requests.' } })
    return
  }
  if (url.includes(UNREADABLE_MARKER)) {
    json(response, 200, { domain: url, summary: null, cacheHit: false, generic: true })
    return
  }
  json(response, 200, RESPONSE_FIXTURES['POST /api/preview'])
}

/**
 * Google's half of signing in, which we cannot run: it answers the way the
 * identity provider does, by sending the browser onward to where the sign-in
 * screen asked it to land.
 *
 * The screen asks in JSON rather than following a redirect, because the real
 * library refuses a sign-in with no anti-forgery token and says so by *naming a
 * destination* rather than by failing — so the press has to read the
 * destination to know whether it worked. Answering with a plain redirect here
 * would leave the screen unable to tell, which is a difference from the real
 * thing rather than a shortcut past it.
 */
function signInAnswer(request: IncomingMessage, response: ServerResponse, rawBody: string): void {
  const callback = new URLSearchParams(rawBody).get('callbackUrl') ?? '/'
  const destination = callback.startsWith('/') ? callback : '/'
  if (request.headers['x-auth-return-redirect']) {
    return json(response, 200, { url: destination })
  }
  response.writeHead(302, { location: destination })
  response.end()
}

/**
 * The Content, Opportunities and onboarding screens, answered from state
 * rather than from a fixed body.
 *
 * Every other route here can answer the same thing twice, because nothing the
 * public funnel does changes what the next read should say. These three
 * screens are the opposite: vetoing a topic and then finding it gone, or
 * scheduling an opportunity and then finding it on the calendar, *is* the
 * assertion. So these routes are served by state that lives for the length of
 * one run — `ContentState` for the calendar, articles and opportunities, and
 * `OnboardingState` for the run that walks a store from no domain to its
 * first scan.
 */
const content = new ContentState()
const onboarding = new OnboardingState()

/** How long a generated recommendation takes to answer, to make the drawer's "generating…" state real rather than instant. */
const GENERATE_DELAY_MS = 400
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function parsedBody(rawBody: string): Record<string, unknown> {
  try {
    return JSON.parse(rawBody === '' ? '{}' : rawBody) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Every answer this server gives from run state, each declared with the address
 * the contract gives it. `declare` refuses at start-up any address the route
 * table does not hold, so a screen wired to a path nobody built cannot be made
 * to pass here — which is exactly how three invented addresses on the
 * Opportunities screen survived to a deployed product.
 *
 * Order matters where a fixed segment could be read as a parameter: the two
 * scan-progress reads and every named opportunity action come before
 * `/api/opportunities/{id}`, for the same reason the route table itself is
 * ordered that way.
 */
const answers: readonly MockRoute[] = [
  declare('GET', '/api/calendar', (response) => {
    json(response, 200, content.calendar())
    return true
  }),

  // Test scaffolding, not a product route: what the screens actually sent, so a
  // flow can assert that vetoing a topic also dismissed the opportunity behind
  // it — which is a second request the screen makes and nothing on the page
  // shows.
  scaffolding('GET', '/api/_e2e/calls', (response) => {
    json(response, 200, { calls: content.calls })
    return true
  }),

  // Also scaffolding: each flow starts from the same calendar and the same
  // fresh account, so the suite does not pass or fail by the order it ran in.
  // `onboarding.reset()` here leaves onboarding *inactive*: every flow but the
  // onboarding spec itself wants `GET /api/account` to answer as the ordinary,
  // already-set-up merchant the frozen fixtures describe.
  scaffolding('POST', '/api/_e2e/reset', (response) => {
    content.reset()
    onboarding.reset()
    json(response, 200, { ok: true })
    return true
  }),

  // The onboarding spec's own reset: a merchant on their first day, with no
  // domain claimed yet. `content` is reset too — activation lands on the same
  // `GET /api/opportunities` the Opportunities screen's own spec drives, and
  // the headline count it asserts has to be the same every run regardless of
  // what another spec file left behind in a shared worker.
  scaffolding('POST', '/api/_e2e/onboarding-reset', (response) => {
    content.reset()
    onboarding.begin()
    json(response, 200, { ok: true })
    return true
  }),

  declare('POST', '/api/calendar/topics', (response, { body: rawBody }) => {
    const input = parsedBody(rawBody)
    const answer = content.add({
      title: String(input.title ?? ''),
      date: String(input.date ?? ''),
      pin: Boolean(input.pin),
    })
    json(response, answer.status, answer.body)
    return true
  }),

  declare('POST', '/api/calendar/topics/{topicId}/veto', (response, { params }) => {
    const answer = content.veto(params[0]!)
    json(response, answer.status, answer.body)
    return true
  }),

  declare('POST', '/api/calendar/topics/{topicId}/move', (response, { params, body: rawBody }) => {
    const answer = content.move(params[0]!, String(parsedBody(rawBody).date ?? ''))
    json(response, answer.status, answer.body)
    return true
  }),

  declare('POST', '/api/calendar/topics/{topicId}/pin', (response, { params, body: rawBody }) => {
    const answer = content.pin(params[0]!, Boolean(parsedBody(rawBody).pinned))
    json(response, answer.status, answer.body)
    return true
  }),

  // ── Opportunities ──────────────────────────────────────────────────────

  declare('GET', '/api/opportunities', (response) => {
    // The onboarding wait card polls this same route: while a run has just
    // been confirmed and the first scan has not "finished" yet, it must keep
    // answering with nothing, or the wait card would skip straight to
    // activation before the merchant ever saw it wait.
    if (onboarding.awaitingFirstScan()) {
      json(response, 200, {
        opportunities: [],
        counts: { open: 0, byAction: {} },
        lastScanAt: null,
        nextScanAt: null,
        limitedIntelligence: false,
        cursor: null,
      })
      return true
    }
    const list = content.opportunitiesList()
    // The activation landing (and the Opportunities screen right after it)
    // carries the badge once GSC was declined during this run — the same fact
    // `onboarding.account()` reports, read here because this response is
    // what `ActivationHeader` and the list header actually take it from.
    json(
      response,
      200,
      onboarding.active && onboarding.hasLimitedIntelligence()
        ? { ...list, limitedIntelligence: true }
        : list,
    )
    return true
  }),

  declare('POST', '/api/opportunities/{id}/dismiss', (response, { params }) => {
    const answer = content.dismissOpportunity(params[0]!)
    json(response, answer.status, answer.body)
    return true
  }),

  declare('POST', '/api/opportunities/{id}/undismiss', (response, { params }) => {
    const answer = content.undismissOpportunity(params[0]!)
    json(response, answer.status, answer.body)
    return true
  }),

  declare('POST', '/api/opportunities/{id}/schedule', (response, { params }) => {
    const answer = content.scheduleOpportunity(params[0]!)
    json(response, answer.status, answer.body)
    return true
  }),

  // Named by what it produces rather than by the opportunity it is produced
  // for, which is where this endpoint was actually built; the opportunity
  // travels in the body.
  declare('POST', '/api/recommendations', async (response, { body: rawBody }) => {
    await sleep(GENERATE_DELAY_MS)
    const answer = content.generateRecommendation(String(parsedBody(rawBody).opportunityId ?? ''))
    json(response, answer.status, answer.body)
    return true
  }),

  declare('GET', '/api/recommendations', (response, { query }) => {
    const answer = content.readRecommendation(query.get('opportunityId') ?? '')
    json(response, answer.status, answer.body)
    return true
  }),

  declare('POST', '/api/recommendations/{id}/apply', (response, { params, body: rawBody }) => {
    const taskId = parsedBody(rawBody).taskId
    const answer = content.applyRecommendation(
      params[0]!,
      typeof taskId === 'string' && taskId !== '' ? taskId : null,
    )
    json(response, answer.status, answer.body)
    return true
  }),

  declare('GET', '/api/opportunities/{id}', (response, { params }) => {
    const detail = content.opportunityDetail(params[0]!)
    json(response, detail ? 200 : 404, detail ?? { error: { code: 'not_found', message: 'gone' } })
    return true
  }),

  // ── Articles ───────────────────────────────────────────────────────────

  declare('GET', '/api/articles', (response) => {
    json(response, 200, articlesList())
    return true
  }),

  declare('GET', '/api/articles/{articleId}', (response, { params }) => {
    const detail = articleDetail(params[0]!)
    json(response, detail ? 200 : 404, detail ?? { error: { code: 'not_found', message: 'gone' } })
    return true
  }),

  ...(['approve', 'discard', 'publish-anyway', 'published-url', 'refresh'] as const).map((action) =>
    declare('POST', `/api/articles/{articleId}/${action}`, (response, { params }) => {
      content.calls.push(`article ${action} ${params[0]!}`)
      json(response, 200, { ok: true })
      return true
    }),
  ),
]

/**
 * Answers that only stand in while the onboarding spec is walking a store from
 * no domain to its first scan. Every other browser flow wants the ordinary,
 * already-set-up account the frozen fixtures describe, so these are consulted
 * only once that spec has called `begin()`, and several of them decline
 * outright when the run has moved past the step they belong to.
 */
const onboardingAnswers: readonly MockRoute[] = [
  declare('GET', '/api/account', (response) => {
    json(response, 200, onboarding.account())
    return true
  }),

  declare('POST', '/api/domain/claim', (response, { body: rawBody }) => {
    const answer = onboarding.claim(String(parsedBody(rawBody).domain ?? ''))
    json(response, answer.status, answer.body)
    return true
  }),

  declare('GET', '/api/ingestion/status', (response) => {
    const status = onboarding.ingestionStatus()
    json(response, status ? 200 : 404, status ?? { error: { code: 'not_found', message: 'no run' } })
    return true
  }),

  // The blocking card asks for an OAuth URL exactly the way the settings
  // screen's write-scope grant does; while the run is actually waiting on it,
  // this hands back our own address instead of Shopify's, so the click has
  // somewhere real to land — the same trick `signInAnswer` above plays for
  // Google.
  declare('POST', '/api/shopify/oauth/start', (response) => {
    if (onboarding.domain?.state !== 'awaiting_shopify_auth') return false
    json(response, 200, { url: `http://localhost:${PORT}/api/_e2e/shopify-callback` })
    return true
  }),

  scaffolding('GET', '/api/_e2e/shopify-callback', (response) => {
    onboarding.connectShopify()
    response.writeHead(302, { location: '/dashboard' })
    response.end()
    return true
  }),

  declare('POST', '/api/gsc/skip', (response) => {
    onboarding.skipSearchConsole()
    json(response, 200, { ok: true })
    return true
  }),

  declare('GET', '/api/profile', (response) => {
    if (onboarding.domain?.state !== 'needs_confirmation') return false
    json(response, 200, onboarding.profileDraft())
    return true
  }),

  declare('POST', '/api/profile/confirm', (response) => {
    if (onboarding.domain?.state !== 'needs_confirmation') return false
    onboarding.confirmProfile()
    json(response, 200, { ok: true })
    return true
  }),
]

async function dynamicAnswer(
  response: ServerResponse,
  method: string,
  pathname: string,
  query: URLSearchParams,
  body: string,
): Promise<boolean> {
  const found = match(answers, method, pathname)
  if (found && (await found.route.handler(response, { params: found.params, body, query }))) {
    return true
  }

  if (!onboarding.active) return false

  const inRun = match(onboardingAnswers, method, pathname)
  if (!inRun) return false
  return await inRun.route.handler(response, { params: inRun.params, body, query })
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = (request.method ?? 'GET').toUpperCase()
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`)
  const body = method === 'GET' || method === 'HEAD' ? '' : await readBody(request)

  if (url.pathname === '/api/preview' && method === 'POST') return previewAnswer(response, body)
  if (url.pathname === '/api/auth/signin/google' && method === 'POST') {
    return signInAnswer(request, response, body)
  }
  if (await dynamicAnswer(response, method, url.pathname, url.searchParams, body)) return

  const fixture = RESPONSE_FIXTURES[`${method} ${url.pathname}`]
  if (fixture !== undefined) return json(response, 200, fixture)

  await passThrough(request, response, url, method, body)
}

/**
 * Everything that is not a fixture is the app itself.
 *
 * The `Host` header is rewritten to point back here, and that rewrite is the
 * whole reason the app's own server-side reads land on these fixtures: a page
 * being rendered has no browser, so it works out where to call itself from the
 * host it was asked on. It is sent with Node's own HTTP client rather than
 * `fetch`, because `Host` is a header the fetch standard forbids setting — the
 * assignment is dropped in silence, the app calls its real API instead, and the
 * page renders as though the merchant had no data.
 */
async function passThrough(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  method: string,
  body: string,
): Promise<void> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    // `accept-encoding` goes with them: this proxy pipes the answer through
    // untouched, so a compressed one would reach the browser as bytes it never
    // agreed to decode.
    if (value === undefined || ['host', 'connection', 'accept-encoding'].includes(name)) continue
    headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  headers.host = `localhost:${PORT}`
  if (body !== '') headers['content-length'] = String(Buffer.byteLength(body))

  const upstream = new URL(`${APP_ORIGIN}${url.pathname}${url.search}`)

  await new Promise<void>((resolve) => {
    const proxied = httpRequest(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: `${upstream.pathname}${upstream.search}`,
        method,
        headers,
      },
      (answer) => {
        const out = { ...answer.headers }
        delete out['connection']
        delete out['transfer-encoding']
        response.writeHead(answer.statusCode ?? 502, out)
        answer.pipe(response)
        answer.on('end', resolve)
      },
    )
    proxied.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' })
      response.end('the app is not answering')
      resolve()
    })
    if (body !== '') proxied.write(body)
    proxied.end()
  })
}

createServer((request, response) => {
  void handle(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500)
    response.end()
  })
}).listen(PORT, () => {
  process.stdout.write(`fixture-backed site on http://localhost:${PORT} (app at ${APP_ORIGIN})\n`)
})
