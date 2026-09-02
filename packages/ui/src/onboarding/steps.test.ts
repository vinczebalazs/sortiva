import { describe, expect, it } from 'vitest'
import {
  formatElapsed,
  ONBOARDING_STEPS,
  resolveStepper,
  STILL_WORKING_AFTER_MS,
  stepperComplete,
  type IngestionStatus,
  type JobStep,
  type JobStepName,
  type JobStepState,
} from './steps'
import { followIngestion, type FollowDependencies, type StreamSource } from './follow'
import { resolveOnboardingSurface } from './surface'
import type { ShellAccount } from '../shell'

const AT = '2026-02-02T09:00:00.000Z'
const NOW = Date.parse(AT)

function step(name: JobStepName, state: JobStepState, startedAt: string | null = AT): JobStep {
  return { step: name, state, startedAt, updatedAt: AT, attempts: state === 'pending' ? 0 : 1 }
}

function run(steps: readonly JobStep[]): IngestionStatus {
  return { jobId: 'job-1', status: 'running', steps, startedAt: AT }
}

const stateOf = (steps: ReturnType<typeof resolveStepper>, id: string) =>
  steps.find((row) => row.id === id)?.state

// ── Seven rows, nine jobs ────────────────────────────────────────────────────

describe('the progress list the merchant sees', () => {
  it('has the seven steps the product names, in order', () => {
    expect(ONBOARDING_STEPS.map((step) => step.id)).toEqual([
      'detect',
      'connect_store',
      'read_store',
      'business_profile',
      'keywords_competitors',
      'search_console',
      'review',
    ])
  })

  it('covers every step the server can report, and invents none', () => {
    const covered = ONBOARDING_STEPS.flatMap((step) => step.jobSteps)
    expect([...covered].sort()).toEqual([
      'awaiting_confirmation',
      'catalog_sync',
      'detect',
      'distill',
      'family_group',
      'gsc_connect',
      'keywords_competitors',
      'oauth_wait',
      'persona',
    ])
    expect(new Set(covered).size).toBe(covered.length)
  })

  it('shows every row as not started before a run reports anything', () => {
    const rows = resolveStepper(null, { now: NOW })
    expect(rows).toHaveLength(7)
    expect(rows.every((row) => row.state === 'pending')).toBe(true)
  })
})

describe('three server-side jobs read as one row', () => {
  const readStore = (states: readonly JobStepState[]) =>
    stateOf(
      resolveStepper(
        run([
          step('catalog_sync', states[0]!),
          step('distill', states[1]!),
          step('family_group', states[2]!),
        ]),
        { now: NOW },
      ),
      'read_store',
    )

  it('is active while any of the three is running', () => {
    expect(readStore(['succeeded', 'running', 'pending'])).toBe('active')
  })

  it('stays active between two of them, rather than reading as finished', () => {
    expect(readStore(['succeeded', 'succeeded', 'pending'])).toBe('active')
  })

  it('is done only when all three are', () => {
    expect(readStore(['succeeded', 'succeeded', 'succeeded'])).toBe('done')
  })

  it('reads as failed the moment any one of them fails, not once the rest finish', () => {
    expect(readStore(['succeeded', 'failed_retryable', 'pending'])).toBe('failed')
  })
})

// ── The step a merchant may decline ──────────────────────────────────────────

describe('Search Console is the one step that can be skipped', () => {
  it('is the only row marked skippable', () => {
    expect(ONBOARDING_STEPS.filter((step) => step.skippable).map((step) => step.id)).toEqual([
      'search_console',
    ])
  })

  it('renders as skipped when the merchant declined it', () => {
    const rows = resolveStepper(run([step('gsc_connect', 'skipped', null)]), { now: NOW })
    expect(stateOf(rows, 'search_console')).toBe('skipped')
  })

  it('counts a skipped step as nothing left to wait for', () => {
    const rows = resolveStepper(
      run([
        step('detect', 'succeeded'),
        step('oauth_wait', 'succeeded'),
        step('catalog_sync', 'succeeded'),
        step('distill', 'succeeded'),
        step('family_group', 'succeeded'),
        step('persona', 'succeeded'),
        step('keywords_competitors', 'succeeded'),
        step('gsc_connect', 'skipped', null),
        step('awaiting_confirmation', 'succeeded'),
      ]),
      { now: NOW },
    )
    expect(stepperComplete(rows)).toBe(true)
  })
})

// ── Saying so when it is slow ────────────────────────────────────────────────

describe('a long step says it is still working', () => {
  const rows = (elapsedMs: number) =>
    resolveStepper(run([step('catalog_sync', 'running')]), { now: NOW + elapsedMs })

  it('says nothing in the first minute', () => {
    const row = rows(30_000).find((row) => row.id === 'read_store')!
    expect(row.stillWorking).toBe(false)
    expect(row.elapsedMs).toBe(30_000)
  })

  it('explains the wait once a minute has passed', () => {
    expect(rows(STILL_WORKING_AFTER_MS).find((row) => row.id === 'read_store')!.stillWorking).toBe(true)
  })

  it('shows no clock on a row that has not started', () => {
    expect(rows(0).find((row) => row.id === 'review')!.elapsedMs).toBeNull()
  })

  it('reads the clock out in minutes and seconds', () => {
    expect(formatElapsed(160_000)).toBe('2m 40s')
    expect(formatElapsed(9_000)).toBe('9s')
  })
})

describe('a failed step distinguishes retrying from stopped', () => {
  it('is retrying while the failure is retryable', () => {
    const row = resolveStepper(run([step('catalog_sync', 'failed_retryable')]), { now: NOW }).find(
      (row) => row.id === 'read_store',
    )!
    expect(row.state).toBe('failed')
    expect(row.retrying).toBe(true)
  })

  it('is not retrying once the failure is terminal', () => {
    const row = resolveStepper(run([step('catalog_sync', 'failed_terminal')]), { now: NOW }).find(
      (row) => row.id === 'read_store',
    )!
    expect(row.retrying).toBe(false)
  })
})

// ── Which screen the dashboard shows ─────────────────────────────────────────

const account = (over: Partial<ShellAccount> = {}): ShellAccount => ({
  domain: { state: 'ingesting', normalized: 'terrafirma.co.uk' },
  subscription: { status: 'active' },
  limitedIntelligence: false,
  connections: { shopify: 'read', searchConsole: 'connected', lastScanAt: null },
  servicePaused: false,
  ...over,
})

describe('the dashboard picks its stage from the account, not from navigation', () => {
  it('asks for a domain when there is none', () => {
    expect(resolveOnboardingSurface({ account: account({ domain: null }) })).toBe('connect_domain')
  })

  it('parks a store that is not on Shopify', () => {
    expect(
      resolveOnboardingSurface({ account: account({ domain: { state: 'unsupported' } }) }),
    ).toBe('parked_unsupported')
  })

  it('blocks on the first Shopify grant', () => {
    expect(
      resolveOnboardingSurface({
        account: account({
          domain: { state: 'awaiting_shopify_auth' },
          connections: { shopify: 'none', searchConsole: 'none', lastScanAt: null },
        }),
      }),
    ).toBe('shopify_blocking')
  })

  it('tells a lost connection apart from a first one, though the domain state is the same', () => {
    expect(
      resolveOnboardingSurface({
        account: account({
          domain: { state: 'awaiting_shopify_auth' },
          connections: { shopify: 'broken', searchConsole: 'connected', lastScanAt: null },
        }),
      }),
    ).toBe('parked_shopify_disconnected')
  })

  it('shows the progress list while a run is in flight', () => {
    expect(resolveOnboardingSurface({ account: account(), status: run([step('persona', 'running')]) })).toBe(
      'ingesting',
    )
  })

  it('blocks on Shopify when the run itself is waiting for the grant', () => {
    expect(
      resolveOnboardingSurface({ account: account(), status: run([step('oauth_wait', 'running')]) }),
    ).toBe('shopify_blocking')
  })

  it('reviews the draft once ingestion is done', () => {
    expect(
      resolveOnboardingSurface({ account: account({ domain: { state: 'needs_confirmation' } }) }),
    ).toBe('confirmation')
  })

  it('waits on the first scan after confirmation, then hands over', () => {
    const confirmed = account({ domain: { state: 'ready_for_planning' } })
    expect(resolveOnboardingSurface({ account: confirmed })).toBe('finding_opportunities')
    expect(
      resolveOnboardingSurface({
        account: { ...confirmed, connections: { ...confirmed.connections, lastScanAt: AT } },
      }),
    ).toBe('complete')
  })
})

// ── Keeping up with a run that is still going ────────────────────────────────

describe('the progress list follows a stream, and falls back when there is none', () => {
  const URLS = { streamUrl: '/api/ingestion/stream', statusUrl: '/api/ingestion/status', pollMs: 5_000 }
  const body = run([step('persona', 'running')])

  function harness(openStream: FollowDependencies['openStream']) {
    const reads: string[] = []
    const timers: { run: () => void; everyMs: number }[] = []
    const seen: IngestionStatus[] = []
    const deps: FollowDependencies = {
      openStream,
      readStatus: async (url) => {
        reads.push(url)
        return body
      },
      schedule: (run, everyMs) => {
        timers.push({ run, everyMs })
        return () => timers.splice(timers.indexOf(timers[timers.length - 1]!), 1)
      },
    }
    return { reads, timers, seen, deps }
  }

  /** A stream that hands its handlers back so a test can fire them. */
  function fakeStream() {
    const handlers: { message?: (s: IngestionStatus) => void; error?: () => void } = {}
    let closed = false
    const source: StreamSource = {
      onMessage: (handler) => {
        handlers.message = handler
      },
      onError: (handler) => {
        handlers.error = handler
      },
      close: () => {
        closed = true
      },
    }
    return { source, handlers, isClosed: () => closed }
  }

  it('reports what the stream sends, and asks for nothing while it works', () => {
    const stream = fakeStream()
    const { reads, seen, deps } = harness(() => stream.source)
    followIngestion(URLS, (status) => seen.push(status), deps)

    stream.handlers.message?.(body)
    expect(seen).toEqual([body])
    expect(reads).toEqual([])
  })

  it('starts asking every few seconds once the stream fails', () => {
    const stream = fakeStream()
    const { reads, timers, deps } = harness(() => stream.source)
    followIngestion(URLS, () => {}, deps)

    stream.handlers.error?.()
    expect(reads).toEqual(['/api/ingestion/status'])
    expect(timers[0]?.everyMs).toBe(5_000)
  })

  it('asks straight away where the browser has no streams at all', () => {
    const { reads, timers, deps } = harness(() => null)
    followIngestion(URLS, () => {}, deps)
    expect(reads).toEqual(['/api/ingestion/status'])
    expect(timers).toHaveLength(1)
  })

  it('does not start a second poll when the stream fails twice', () => {
    const stream = fakeStream()
    const { timers, deps } = harness(() => stream.source)
    followIngestion(URLS, () => {}, deps)

    stream.handlers.error?.()
    stream.handlers.error?.()
    expect(timers).toHaveLength(1)
  })

  it('closes the stream and stops the timer when the screen goes away', () => {
    const stream = fakeStream()
    const { timers, deps } = harness(() => stream.source)
    const stop = followIngestion(URLS, () => {}, deps)

    stream.handlers.error?.()
    stop()
    expect(stream.isClosed()).toBe(true)
    expect(timers).toHaveLength(0)
  })
})
