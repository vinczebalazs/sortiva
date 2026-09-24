#!/usr/bin/env node
/**
 * **Starts the application that was just built, and asks it for a page.**
 *
 * Everything else in the gate looked at the code. Lint, typecheck, 1,357 tests,
 * the contract check, the eval sets, the chaos scenarios and `pnpm build` all
 * passed, every day, while the deployed product answered 500 to every single
 * request — the landing page and the health check included. Nothing in the gate
 * had ever started the thing.
 *
 * So this does the one thing none of them did. It runs the built server the way
 * the platform runs it, waits for it to answer, and asks it for three things:
 * the landing page, which is the public funnel; the health check, which is what
 * the platform polls to decide whether to keep the container; and the preview
 * endpoint, which is the funnel's only moving part. A server that will not start
 * does not answer at all, and Next answers 500 to everything when its start-up
 * hook throws, so either failure lands here.
 *
 * The preview is here because two pages were not enough: the landing page
 * rendered perfectly while every preview answered 500, for a reason that only
 * exists in a built application — a file path the bundler rewrote. Nothing that
 * reads source could see it, and neither could a check that only asked for
 * pages.
 *
 * It deliberately does not build: `pnpm build` is the step before it, and a
 * smoke check that rebuilds hides which of the two failed.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const webDir = join(repoRoot, 'apps', 'web')

/** How long the server gets to start answering at all, and then to answer healthily. */
const READY_TIMEOUT_MS = 90_000
const HEALTHY_TIMEOUT_MS = 30_000

/**
 * Next reads `.env` only from the directory it is started in, and the server is
 * started from `apps/web` while the file lives at the repository root. So it is
 * read here and handed over, exactly as the Playwright harness does.
 */
function repoEnv() {
  const values = {}
  let contents
  try {
    contents = readFileSync(join(repoRoot, '.env'), 'utf8')
  } catch {
    return values
  }
  for (const line of contents.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match?.[1]) continue
    values[match[1]] = (match[2] ?? '').trim().replace(/^["'](.*)["']$/, '$1')
  }
  return values
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function get(url) {
  try {
    const response = await fetch(url, { redirect: 'manual' })
    return { status: response.status, body: (await response.text()).slice(0, 400) }
  } catch (error) {
    return { status: 0, body: String(error?.cause?.code ?? error?.message ?? error) }
  }
}

/**
 * Asks the preview for a card the way the landing page does, and reports what
 * came back.
 *
 * It deliberately does **not** expect a card. Getting one means passing a real
 * bot challenge and paying for a model call, which a check that runs on every
 * build must not do. What it proves instead is that the request reached the
 * preview's own code: the bot challenge refusing a junk token is a *working*
 * preview, and the failure this exists to catch — the prompt file not being
 * where the built application looks for it — is a 500 raised before any of that
 * is reached.
 */
async function postPreview(url) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', turnstileToken: 'smoke-check-not-a-real-token' }),
    })
    return { status: response.status, body: (await response.text()).slice(0, 400) }
  } catch (error) {
    return { status: 0, body: String(error?.cause?.code ?? error?.message ?? error) }
  }
}

const port = process.env.SMOKE_PORT ? Number(process.env.SMOKE_PORT) : await freePort()
const base = `http://127.0.0.1:${port}`

/**
 * `--dev` runs the same two checks against `next dev` instead of the built
 * application. It exists because the two builds are not the same build: Next
 * compiles the start-up hook for the Edge runtime as well as Node, and Edge has
 * no filesystem — so a Node-only import reachable from that hook breaks `next
 * dev` while `pnpm build` stays green. That is exactly what happened, it made
 * every page in development answer 500, and nothing in the gate could see it
 * because the gate only ever started the built app.
 */
const dev = process.argv.includes('--dev')

if (!dev && !existsSync(join(webDir, '.next', 'BUILD_ID'))) {
  console.error('No production build found in apps/web/.next. Run `pnpm build` first.')
  process.exit(1)
}

const env = {
  ...repoEnv(),
  ...process.env,
  // The same trade the browser-flow harness makes: the repository ships no key
  // for encrypting merchant tokens — correctly, since a committed key is not a
  // key — and the start-up hook refuses to run without one. Nothing here stores
  // a token, so a throwaway made per run is enough to let the server boot.
  ENCRYPTION_MASTER_KEY: process.env.ENCRYPTION_MASTER_KEY || repoEnv().ENCRYPTION_MASTER_KEY || randomBytes(32).toString('base64'),
  // What `railway.toml` sets, so the process under test handles signals the way
  // the deployed one does.
  NEXT_MANUAL_SIG_HANDLE: '1',
  PORT: String(port),
}

const started = Date.now()
const server = spawn(
  process.execPath,
  [join(webDir, 'node_modules', 'next', 'dist', 'bin', 'next'), dev ? 'dev' : 'start', '-p', String(port)],
  { cwd: webDir, env, stdio: ['ignore', 'pipe', 'pipe'] },
)

let log = ''
let exited = null
server.stdout.on('data', (chunk) => { log += chunk })
server.stderr.on('data', (chunk) => { log += chunk })
server.on('exit', (code, signal) => { exited = { code, signal } })

function stopServer() {
  if (exited) return
  server.kill('SIGTERM')
  setTimeout(() => server.kill('SIGKILL'), 5_000).unref()
}

function fail(message, detail) {
  console.error(`FAIL  ${message}`)
  if (detail) console.error(detail)
  console.error('\n--- server output ------------------------------------------')
  console.error(log.trim() || '(the server printed nothing)')
  console.error('------------------------------------------------------------')
  stopServer()
  process.exit(1)
}

// Phase 1: it has to answer something. A server whose start-up hook threw still
// listens and answers 500, which is why answering is not the same as working.
let answered = false
while (Date.now() - started < READY_TIMEOUT_MS) {
  if (exited) {
    fail(`the server exited before it answered (code ${exited.code}, signal ${exited.signal})`)
  }
  const { status } = await get(`${base}/api/health`)
  if (status !== 0) {
    answered = true
    break
  }
  await sleep(500)
}
if (!answered) fail(`the server did not answer within ${READY_TIMEOUT_MS / 1000}s`)

// Phase 2: the health check has to go green. The worker connects to the database
// after the server starts listening, so "up" and "ready" are seconds apart on a
// cold database — a grace window here, not a retry that hides a real failure.
const healthyBy = Date.now() + (dev ? HEALTHY_TIMEOUT_MS * 4 : HEALTHY_TIMEOUT_MS)
let health = await get(`${base}/api/health`)
while (health.status !== 200 && Date.now() < healthyBy) {
  await sleep(500)
  health = await get(`${base}/api/health`)
}

const landing = await get(`${base}/`)

const results = [
  ['/', landing],
  ['/api/health', health],
]
for (const [path, result] of results) {
  console.log(`${result.status === 200 ? 'PASS' : 'FAIL'}  GET ${path} -> ${result.status}`)
}

const broken = results.filter(([, result]) => result.status !== 200)
if (broken.length > 0) {
  fail(
    `the ${dev ? 'development' : 'built'} application does not serve ${broken.map(([path]) => path).join(' or ')}`,
    broken.map(([path, result]) => `  GET ${path} -> ${result.status}\n  ${result.body}`).join('\n'),
  )
}

const preview = await postPreview(`${base}/api/preview`)
if (preview.status === 500 || preview.status === 0) {
  console.log(`FAIL  POST /api/preview -> ${preview.status}`)
  fail(
    'the preview endpoint failed before it could refuse anything',
    `  POST /api/preview -> ${preview.status}\n  ${preview.body}`,
  )
}
if (preview.status === 503) {
  console.log(`FAIL  POST /api/preview -> 503`)
  fail(
    'the preview refused before it reached its own wiring, so this check could not see whether it works',
    'TURNSTILE_SECRET_KEY is unset. The endpoint answers 503 at the bot challenge, before the\n' +
      'prompt file and the vendor clients are built — which is the half this check exists to\n' +
      'exercise. Set the key (any value will do; the token below is refused either way).',
  )
}
console.log(`PASS  POST /api/preview -> ${preview.status} (reached the preview, refused the junk token)`)

console.log(`\nThe ${dev ? 'development' : 'built'} application started and served the funnel in ${((Date.now() - started) / 1000).toFixed(1)}s.`)
stopServer()
process.exit(0)
