import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { RESPONSE_FIXTURES } from '@sortiva/ui/msw/fixtures'

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

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = (request.method ?? 'GET').toUpperCase()
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`)
  const body = method === 'GET' || method === 'HEAD' ? '' : await readBody(request)

  if (url.pathname === '/api/preview' && method === 'POST') return previewAnswer(response, body)
  if (url.pathname === '/api/auth/signin/google' && method === 'POST') {
    return signInAnswer(response, body)
  }

  const fixture = RESPONSE_FIXTURES[`${method} ${url.pathname}`]
  if (fixture !== undefined) return json(response, 200, fixture)

  await passThrough(request, response, url, method, body)
}

/** Everything that is not a fixture is the app itself. */
async function passThrough(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  method: string,
  body: string,
): Promise<void> {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || name === 'host' || name === 'connection') continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  // The app reads its own host header to call itself; keeping it pointed here
  // is what makes its server-side reads land on the fixtures too.
  headers.set('host', `localhost:${PORT}`)

  let upstream: Response
  try {
    upstream = await fetch(`${APP_ORIGIN}${url.pathname}${url.search}`, {
      method,
      headers,
      body: body === '' ? undefined : body,
      redirect: 'manual',
    })
  } catch {
    response.writeHead(502, { 'content-type': 'text/plain' })
    response.end('the app is not answering')
    return
  }

  const out = new Headers(upstream.headers)
  out.delete('content-encoding')
  out.delete('content-length')
  out.delete('transfer-encoding')
  response.writeHead(upstream.status, Object.fromEntries(out.entries()))
  response.end(Buffer.from(await upstream.arrayBuffer()))
}

createServer((request, response) => {
  void handle(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500)
    response.end()
  })
}).listen(PORT, () => {
  process.stdout.write(`fixture-backed site on http://localhost:${PORT} (app at ${APP_ORIGIN})\n`)
})
