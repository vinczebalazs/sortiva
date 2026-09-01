import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { gunzipSync } from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { PosthogServerCapture } from '@sortiva/providers'
import { accountAttribution, captureStubUsed, silentLogger } from '@sortiva/core'
import { appServices, initAppServices, resetAppServices } from '@sortiva/core/runtime/services'
import { TEST_DATABASE_URL, databaseAvailable, setupTestDb, type TestDb } from '@sortiva/db/testing'
import { bootstrapWorker, flushAnalytics } from './bootstrap'

/**
 * Card R5. PostHog had received nothing since the project began, because no
 * running process ever constructed a client — the class was written, tested and
 * uncalled. A test that asserts "the capture function was called" is exactly the
 * evidence that failure already passed, so this suite asserts something else:
 * that an event **leaves the process over HTTP and arrives**, at a real server
 * stood up here, through the real `posthog-node` client, and only after the
 * shutdown flush that a deploy triggers.
 *
 * No PostHog credentials exist (`.env` has no key), so the endpoint is local.
 * What that cannot prove is PostHog's own acceptance of the payload — see
 * DECISIONS 2026-09-01 R5.
 */

interface ReceivedRequest {
  readonly path: string
  readonly body: PosthogBatch
}

interface PosthogBatch {
  api_key?: string
  batch?: {
    event: string
    distinct_id: string
    properties: Record<string, unknown>
  }[]
}

const received: ReceivedRequest[] = []
let server: Server
let host: string

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void readBody(req).then((raw) => {
      const decoded = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw
      received.push({
        path: req.url ?? '',
        body: JSON.parse(decoded.toString('utf8')) as PosthogBatch,
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 1 }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

afterEach(() => {
  received.length = 0
  resetAppServices()
})

const quiet = { log: () => {}, error: () => {} }

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the analytics endpoint')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const events = () => received.flatMap((r) => r.body.batch ?? [])

describe('an event reaches the analytics endpoint (main §14.7)', () => {
  it('is held in the batch until the shutdown flush, then delivered with its ids and groups', async () => {
    const { analytics } = initAppServices(() => ({
      analytics: new PosthogServerCapture({ apiKey: 'phc_r5_local_test', host, logger: silentLogger }),
    }))

    // An existing capture point, reached the way a call site reaches it: through
    // the bundle the entry point built. No new event type (`stub_used` is the
    // stub marker that already exists).
    captureStubUsed(appServices().analytics, 'existingTargetCheck', accountAttribution('acct-r5', 'example.com'), {
      method: 'check',
    })

    // The library batches and sends in the background, so at this instant the
    // event exists only in this process's memory — which is precisely what a
    // deploy used to throw away.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(events()).toHaveLength(0)

    await flushAnalytics(analytics, quiet)
    await waitFor(() => events().length > 0)

    const [delivered] = events()
    expect(delivered?.event).toBe('stub_used')
    expect(delivered?.distinct_id).toBe('acct-r5')
    expect(delivered?.properties.contract).toBe('existingTargetCheck')
    expect(delivered?.properties.account_id).toBe('acct-r5')
    // Everything is groupable by domain.
    expect(delivered?.properties.$groups).toEqual({ domain: 'example.com' })
    expect(received[0]?.body.api_key).toBe('phc_r5_local_test')
  })
})

const available = await databaseAvailable()

describe.skipIf(!available)('the worker drain flushes what the process captured (tech §2.1)', () => {
  let test: TestDb

  beforeAll(async () => {
    test = await setupTestDb('r5_analytics')
  })

  afterAll(async () => {
    await test.close()
  })

  it('delivers on SIGTERM through the real bootstrap, not through a hand-built handler', async () => {
    const options = (test.pool as unknown as { options: { connectionString?: string } }).options
    const url = new URL(options.connectionString ?? TEST_DATABASE_URL)

    const { analytics } = initAppServices(() => ({
      analytics: new PosthogServerCapture({ apiKey: 'phc_r5_local_test', host, logger: silentLogger }),
    }))

    let exitCode: number | undefined
    const worker = await bootstrapWorker({
      analytics,
      connectionString: url.toString(),
      logger: quiet,
      // The drain ends in process.exit and listens for the signals the test
      // runner also handles, so both are redirected here.
      signals: ['SIGUSR2'],
      exit: (code) => {
        exitCode = code
      },
    })
    expect(worker).toBeDefined()

    captureStubUsed(appServices().analytics, 'existingTargetCheck', accountAttribution('acct-drain'), {
      method: 'check',
    })
    expect(events()).toHaveLength(0)

    process.emit('SIGUSR2')
    await waitFor(() => exitCode !== undefined)
    await waitFor(() => events().length > 0)

    expect(exitCode).toBe(0)
    expect(events()[0]?.distinct_id).toBe('acct-drain')
  })
})
