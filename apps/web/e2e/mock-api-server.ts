import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { RESPONSE_FIXTURES } from '@sortiva/ui/msw/fixtures'
import { ContentState, articleDetail, articlesList } from './content-state'

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
 */
function signInAnswer(response: ServerResponse, rawBody: string): void {
  const callback = new URLSearchParams(rawBody).get('callbackUrl') ?? '/'
  response.writeHead(302, { location: callback.startsWith('/') ? callback : '/' })
  response.end()
}

/**
 * The Content screens, answered from state rather than from a fixed body.
 *
 * Every other route here can answer the same thing twice, because nothing the
 * public funnel does changes what the next read should say. The calendar is the
 * opposite: vetoing a topic and then finding it gone *is* the assertion, and
 * half of what the screen renders depends on which side of today a day falls
 * on. So these routes are served by `ContentState`, which lives for the length
 * of one run.
 */
const content = new ContentState()

function contentAnswer(
  response: ServerResponse,
  method: string,
  pathname: string,
  rawBody: string,
): boolean {
  const parsed = (): Record<string, unknown> => {
    try {
      return JSON.parse(rawBody === '' ? '{}' : rawBody) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  if (method === 'GET' && pathname === '/api/calendar') {
    json(response, 200, content.calendar())
    return true
  }

  // Test scaffolding, not a product route: what the screens actually sent, so a
  // flow can assert that vetoing a topic also dismissed the opportunity behind
  // it — which is a second request the screen makes and nothing on the page
  // shows.
  if (method === 'GET' && pathname === '/api/_e2e/calls') {
    json(response, 200, { calls: content.calls })
    return true
  }

  // Also scaffolding: each flow starts from the same calendar, so the suite
  // does not pass or fail by the order it ran in.
  if (method === 'POST' && pathname === '/api/_e2e/reset') {
    content.reset()
    json(response, 200, { ok: true })
    return true
  }

  if (method === 'POST' && pathname === '/api/calendar/topics') {
    const input = parsed()
    const answer = content.add({
      title: String(input.title ?? ''),
      date: String(input.date ?? ''),
      pin: Boolean(input.pin),
    })
    json(response, answer.status, answer.body)
    return true
  }

  const topicAction = /^\/api\/calendar\/topics\/([^/]+)\/(veto|move|pin)$/.exec(pathname)
  if (method === 'POST' && topicAction) {
    const id = topicAction[1]!
    const input = parsed()
    const answer =
      topicAction[2] === 'veto'
        ? content.veto(id)
        : topicAction[2] === 'move'
          ? content.move(id, String(input.date ?? ''))
          : content.pin(id, Boolean(input.pinned))
    json(response, answer.status, answer.body)
    return true
  }

  const dismiss = /^\/api\/opportunities\/([^/]+)\/dismiss$/.exec(pathname)
  if (method === 'POST' && dismiss) {
    const answer = content.dismissOpportunity(dismiss[1]!)
    json(response, answer.status, answer.body)
    return true
  }

  if (method === 'GET' && pathname === '/api/articles') {
    json(response, 200, articlesList())
    return true
  }

  const article = /^\/api\/articles\/([^/]+)$/.exec(pathname)
  if (method === 'GET' && article) {
    const detail = articleDetail(article[1]!)
    json(response, detail ? 200 : 404, detail ?? { error: { code: 'not_found', message: 'gone' } })
    return true
  }

  const articleAction = /^\/api\/articles\/([^/]+)\/([a-z-]+)$/.exec(pathname)
  if (method === 'POST' && articleAction) {
    content.calls.push(`article ${articleAction[2]} ${articleAction[1]}`)
    json(response, 200, { ok: true })
    return true
  }

  return false
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = (request.method ?? 'GET').toUpperCase()
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`)
  const body = method === 'GET' || method === 'HEAD' ? '' : await readBody(request)

  if (url.pathname === '/api/preview' && method === 'POST') return previewAnswer(response, body)
  if (url.pathname === '/api/auth/signin/google' && method === 'POST') {
    return signInAnswer(response, body)
  }
  if (contentAnswer(response, method, url.pathname, body)) return

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
