import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { stableHash } from '../../core/hash.ts'

const recordingsDir = new URL('./recordings/', import.meta.url)
const REAL_API = 'https://api.anthropic.com'

export type Recording = {
  recordedAt: string
  request: Record<string, unknown>
  status: number
  response: unknown
}

export type FakeAnthropic = {
  url: string
  /** Requests answered, by hash, in order. */
  served: { hash: string; source: 'recording' | 'live' | 'override' }[]
  /**
   * Answer the next request `match` accepts with `respond(recorded)` instead of the recording. `recorded` is the
   * request's own recording, or else a recording of the same prompt (same system text), so a seeded answer always
   * descends from a real one.
   */
  override: (match: (request: Record<string, unknown>) => boolean, respond: (recorded: Recording) => unknown) => void
  /** While on, every request is answered with Anthropic's documented overloaded error, as during an outage. */
  outage: (on: boolean) => void
  /** Overrides registered and not yet used. */
  pendingOverrides: () => number
  close: () => Promise<void>
}

function samePrompt(request: Record<string, unknown>): Recording | undefined {
  for (const name of readdirSync(recordingsDir)) {
    if (!name.endsWith('.json')) continue
    const rec = JSON.parse(readFileSync(new URL(name, recordingsDir), 'utf8')) as Recording
    if (rec.status === 200 && rec.request.system === request.system) return rec
  }
  return undefined
}

export function recordingHash(request: unknown): string {
  return stableHash(request).slice(0, 40)
}

/**
 * Serves model answers from recordings/. With `record: true` an unrecorded request is
 * sent to the real API with the real key and the answer is saved, so the next run is free.
 */
export async function startFakeAnthropic(options: { record?: boolean; apiKey?: string } = {}): Promise<FakeAnthropic> {
  const served: FakeAnthropic['served'] = []
  let down = false
  const overrides: { match: (r: Record<string, unknown>) => boolean; respond: (rec: Recording) => unknown }[] = []

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'request-id': `req_fake_${served.length}` })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
      return send(404, { type: 'error', error: { type: 'not_found_error', message: `fake Anthropic does not serve ${req.url}` } })
    }
    if (down) return send(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    const hash = recordingHash(request)
    const file = new URL(`${hash}.json`, recordingsDir)
    const recording = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Recording) : undefined

    const overrideIndex = overrides.findIndex((o) => o.match(request))
    const template = overrideIndex >= 0 ? (recording ?? samePrompt(request)) : undefined
    if (overrideIndex >= 0 && template) {
      const [o] = overrides.splice(overrideIndex, 1)
      served.push({ hash, source: 'override' })
      return send(200, o!.respond(template))
    }
    if (recording) {
      served.push({ hash, source: 'recording' })
      return send(recording.status, recording.response)
    }
    if (!options.record || !options.apiKey) {
      return send(400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: `fake Anthropic has no recording ${hash}; run the scenario once with RECORD=1 to record it` },
      })
    }
    let live: Response
    try {
      live = await fetch(`${REAL_API}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(request),
      })
    } catch (error) {
      // Passed on as an overload, which the client retries, rather than leaving the request hanging.
      return send(529, { type: 'error', error: { type: 'overloaded_error', message: `real API unreachable while recording: ${(error as Error).message}` } })
    }
    const response = await live.json()
    if (live.ok) {
      const record: Recording = { recordedAt: new Date().toISOString(), request, status: live.status, response }
      // Written whole, then renamed, so a reader never sees half a recording.
      const partial = new URL(`${hash}.json.partial`, recordingsDir)
      writeFileSync(partial, JSON.stringify(record, null, 2) + '\n')
      renameSync(partial, file)
    }
    served.push({ hash, source: 'live' })
    send(live.status, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    served,
    override: (match, respond) => overrides.push({ match, respond }),
    pendingOverrides: () => overrides.length,
    outage: (on) => {
      down = on
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
