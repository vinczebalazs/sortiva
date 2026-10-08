import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { stableHash } from '../../core/hash.ts'
import { ENDPOINTS, PRICE_USD, type Endpoint } from '../../vendors/dataforseo/prices.ts'

const recordingsDir = new URL('./recordings/', import.meta.url)
const samplesDir = new URL('./published-samples/', import.meta.url)
const REAL_API = 'https://api.dataforseo.com'

export type Recording = { recordedAt: string; endpoint: Endpoint; task: Record<string, unknown>; response: unknown }

export type VolumeTask = { keywords: string[]; location_code: number; language_code: string }
export type SerpTask = { keyword: string; location_code: number; language_code: string; depth: number }
export type ScriptedPage = { url: string; title?: string; price?: boolean }

/** A scenario's answers. Returning undefined passes the request on to the recordings. */
export type Script = {
  volume?: (keyword: string, task: VolumeTask) => number | null | undefined
  serp?: (keyword: string, task: SerpTask) => ScriptedPage[] | undefined
  /** Answers every request with this DataForSEO status code instead, e.g. 40210 for insufficient funds. */
  failWith?: number
}

export type FakeDataForSeo = {
  url: string
  login: string
  password: string
  requests: { endpoint: Endpoint; task: Record<string, unknown>; source: 'script' | 'recording' | 'live' | 'default' | 'error' }[]
  script: (script: Script) => void
  close: () => Promise<void>
}

export function recordingName(endpoint: Endpoint, task: unknown): string {
  return `${endpoint.split('/')[0]}-${stableHash({ endpoint, task }).slice(0, 32)}.json`
}

type Sample = { response: Record<string, any> }
const sample = (name: string) => (JSON.parse(readFileSync(new URL(name, samplesDir), 'utf8')) as Sample).response

/**
 * Answers in the form of DataForSEO's published examples (published-samples/), with values from,
 * in order: the scenario's script, a recording of the real API, the real API itself when recording,
 * or a deterministic default so that a scenario which does not care about the numbers still runs.
 */
export async function startFakeDataForSeo(options: { record?: boolean; realLogin?: string; realPassword?: string } = {}): Promise<FakeDataForSeo> {
  const login = 'fake-login'
  const password = 'fake-password'
  const requests: FakeDataForSeo['requests'] = []
  let script: Script = {}

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const send = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const endpoint = (req.url ?? '').replace(/^\/v3\//, '').replace(/\/$/, '') as Endpoint
    if (req.headers.authorization !== 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64')) {
      return send(errorEnvelope(endpoint, 40100, 'You are not authorized to access this resource.'))
    }
    if (req.method !== 'POST' || !Object.values(ENDPOINTS).includes(endpoint)) {
      return send(errorEnvelope(endpoint, 40400, 'Not Found.'))
    }
    const task = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>[])[0]!
    if (script.failWith) {
      requests.push({ endpoint, task, source: 'error' })
      return send(errorEnvelope(endpoint, script.failWith, ERROR_MESSAGES[script.failWith] ?? 'Error.'))
    }

    const scripted = endpoint === ENDPOINTS.searchVolume ? scriptedVolume(task as VolumeTask, script) : scriptedSerp(task as SerpTask, script)
    if (scripted) {
      requests.push({ endpoint, task, source: 'script' })
      return send(scripted)
    }
    const file = new URL(recordingName(endpoint, task), recordingsDir)
    if (existsSync(file)) {
      requests.push({ endpoint, task, source: 'recording' })
      return send((JSON.parse(readFileSync(file, 'utf8')) as Recording).response)
    }
    if (options.record && options.realLogin && options.realPassword) {
      const live = await fetch(`${REAL_API}/v3/${endpoint}`, {
        method: 'POST',
        headers: { authorization: 'Basic ' + Buffer.from(`${options.realLogin}:${options.realPassword}`).toString('base64'), 'content-type': 'application/json' },
        body: JSON.stringify([task]),
      })
      const response = (await live.json()) as { status_code: number }
      if (response.status_code === 20000) {
        const recording: Recording = { recordedAt: new Date().toISOString(), endpoint, task, response }
        writeFileSync(file, JSON.stringify(recording, null, 1) + '\n')
      }
      requests.push({ endpoint, task, source: 'live' })
      return send(response)
    }
    requests.push({ endpoint, task, source: 'default' })
    send(endpoint === ENDPOINTS.searchVolume ? volumeEnvelope(task as VolumeTask, defaultVolume) : serpEnvelope(task as SerpTask, defaultSerp(task as SerpTask)))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    login,
    password,
    requests,
    script: (s) => {
      script = s
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

// Messages as listed on https://docs.dataforseo.com/v3/appendix/errors/ (2026-10-08).
const ERROR_MESSAGES: Record<number, string> = {
  40200: 'Payment Required.',
  40210: "Insufficient funds. Your account's balance is too low to complete this request.",
  50000: 'Internal Error.',
  50301: '3rd party API service unavailable.',
}

function scriptedVolume(task: VolumeTask, script: Script) {
  if (!script.volume) return undefined
  const values = task.keywords.map((k) => script.volume!(k, task))
  if (values.every((v) => v === undefined)) return undefined
  return volumeEnvelope(task, (k) => {
    const v = script.volume!(k, task)
    return v === undefined ? defaultVolume(k) : v
  })
}

function scriptedSerp(task: SerpTask, script: Script) {
  const pages = script.serp?.(task.keyword, task)
  return pages ? serpEnvelope(task, pages) : undefined
}

/** Monthly searches the fake reports when nobody scripted or recorded a phrase: stable per phrase, some under any floor. */
export function defaultVolume(keyword: string): number | null {
  const steps = [null, 10, 30, 90, 170, 260, 480, 880, 1300, 2400]
  return steps[parseInt(stableHash(keyword).slice(0, 8), 16) % steps.length]!
}

function defaultSerp(task: SerpTask): ScriptedPage[] {
  const slug = task.keyword.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-')
  const seed = stableHash(task.keyword).slice(0, 6)
  return Array.from({ length: task.depth }, (_, i) => ({ url: `https://site-${seed}-${i + 1}.example/guides/${slug}`, title: `${task.keyword} — guide ${i + 1}` }))
}

function envelopeFor(endpoint: Endpoint, task: Record<string, unknown>, template: Record<string, any>, result: unknown[]) {
  const envelope = structuredClone(template)
  const cost = PRICE_USD[endpoint]
  envelope.cost = cost
  envelope.time = '0.0100 sec.'
  envelope.tasks = [{ ...envelope.tasks[0], id: `fake-${stableHash(task).slice(0, 24)}`, cost, result_count: result.length, data: { api: envelope.tasks[0].data.api, function: envelope.tasks[0].data.function, se: envelope.tasks[0].data.se, se_type: envelope.tasks[0].data.se_type, ...task }, result }]
  return envelope
}

function volumeEnvelope(task: VolumeTask, volume: (keyword: string) => number | null) {
  const template = sample('search_volume.json')
  const row = template.tasks[0].result[0]
  const result = task.keywords.map((keyword) => {
    const searches = volume(keyword)
    return {
      ...row,
      keyword,
      location_code: task.location_code,
      language_code: task.language_code,
      search_volume: searches,
      competition: searches === null ? null : row.competition,
      competition_index: searches === null ? null : row.competition_index,
      monthly_searches: searches === null ? null : row.monthly_searches.map((m: Record<string, number>) => ({ ...m, search_volume: searches })),
    }
  })
  return envelopeFor(ENDPOINTS.searchVolume, task, template, result)
}

function serpEnvelope(task: SerpTask, pages: ScriptedPage[]) {
  const template = sample('serp_organic.json')
  const base = template.tasks[0].result[0]
  const organic = base.items.find((i: { type: string }) => i.type === 'organic')
  const items = pages.slice(0, task.depth).map((page, i) => {
    const url = new URL(page.url)
    return {
      ...organic,
      rank_group: i + 1,
      rank_absolute: i + 1,
      xpath: `/html[1]/body[1]/div[${i + 1}]`,
      domain: url.hostname,
      title: page.title ?? url.hostname,
      url: page.url,
      breadcrumb: `${url.origin} › ${url.pathname.split('/').filter(Boolean).join(' › ')}`,
      website_name: url.hostname,
      description: '',
      extended_snippet: null,
      rating: null,
      price: page.price ? organic.price : null,
      related_result: null,
    }
  })
  const result = [
    {
      ...base,
      keyword: task.keyword,
      location_code: task.location_code,
      language_code: task.language_code,
      check_url: `https://www.google.com/search?q=${encodeURIComponent(task.keyword)}`,
      refinement_chips: null,
      item_types: ['organic'],
      items_count: items.length,
      items,
    },
  ]
  return envelopeFor(ENDPOINTS.topResults, task, template, result)
}

// Unverified: the docs list the codes but publish no error body. Request-level failures (auth, path) are
// assumed to show at the top level, task-level ones (funds, upstream) inside the task.
function errorEnvelope(endpoint: string, code: number, message: string) {
  const template = sample('search_volume.json')
  const requestLevel = code === 40100 || code === 40400
  return {
    ...template,
    status_code: requestLevel ? code : 20000,
    status_message: requestLevel ? message : 'Ok.',
    cost: 0,
    tasks_count: 1,
    tasks_error: 1,
    tasks: [{ ...template.tasks[0], status_code: code, status_message: message, cost: 0, result_count: 0, path: ['v3', ...endpoint.split('/')], result: null }],
  }
}
